import { z } from 'zod'
import { ALERT_CHANNELS, ALERT_SEVERITIES, RULE_KINDS, RULE_TRIGGERS, type AlertChannel, type AlertSeverity, type RuleKind, type RuleTrigger } from '@nexus/factory-domain/alerts/kinds'
import { TIMER_STATUSES } from '@nexus/factory-domain/timers/rules'
import type { ApiClient } from '../../../lib/api/client'
import { newIdempotencyKey } from '../../../lib/api/client'

/**
 * Every call about the exception rules (B-W2a-33's routes; B-W2a-78's screens: Home › Alerts "Rules" and Admin ›
 * Approvals, automation & AI "Reminders & timers"), the answers checked with zod (unknown fields dropped, so a new API field
 * never breaks a page). The shapes mirror apps/factory-api platform/alerts/contract.ts; the enum lists are factory-domain's
 * own. The API's English words (`kindLabel`, `cooldownWords`, a test sample's `sentence`) are never drawn: the screens say a
 * rule in the reader's language (`sentence.it|en`, or the RuleSentence from its numbers).
 */

export type { AlertChannel, AlertSeverity, RuleKind, RuleTrigger }
export type Threshold = Record<string, number | boolean>

const threshold = z.record(z.string(), z.union([z.number(), z.boolean()]))

export const ruleSchema = z.object({
  id: z.string(),
  ruleKind: z.enum(RULE_KINDS),
  trigger: z.enum(RULE_TRIGGERS),
  name: z.string(),
  sentence: z.object({ en: z.string(), it: z.string() }),
  threshold,
  severity: z.enum(ALERT_SEVERITIES),
  place: z.object({ companyId: z.string().nullable(), siteId: z.string().nullable(), label: z.string().nullable() }),
  recipient: z.object({ roleId: z.string(), name: z.string() }).nullable(),
  channels: z.array(z.enum(ALERT_CHANNELS)),
  cooldownMinutes: z.number(),
  enabled: z.boolean(),
  builtIn: z.boolean(),
  lastFiredAt: z.string().nullable(),
  fired7Days: z.number(),
  openAlerts: z.number(),
  timers: z.object({ pending: z.number(), nextFireAt: z.string().nullable() }).nullable(),
  canChange: z.boolean(),
  version: z.number(),
})
export type AlertRule = z.infer<typeof ruleSchema>

export const kindSchema = z.object({
  kind: z.enum(RULE_KINDS),
  trigger: z.enum(RULE_TRIGGERS),
  recordType: z.string(),
  defaults: threshold,
})
export type RuleKindInfo = z.infer<typeof kindSchema>

const rulesSchema = z.object({ asOf: z.string(), rules: z.array(ruleSchema), kinds: z.array(kindSchema), canAdd: z.boolean() })
export type RulesList = z.infer<typeof rulesSchema>

const record = z.object({ type: z.string(), id: z.string(), label: z.string() })

const testSchema = z.object({ wouldFind: z.number(), complete: z.boolean(), sample: z.array(z.object({ record })), fired7Days: z.number() })
export type RuleTest = z.infer<typeof testSchema>

export const timerSchema = z.object({
  id: z.string(),
  timerKey: z.string(),
  record: z.object({ type: z.string(), id: z.string(), label: z.string().nullable() }),
  dueAt: z.string(),
  fireAt: z.string(),
  status: z.enum(TIMER_STATUSES),
  firedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
})
export type RuleTimer = z.infer<typeof timerSchema>

const named = z.object({ id: z.string(), name: z.string() })
const choicesSchema = z.object({ roles: z.array(named.extend({ key: z.string().optional() })), everywhere: z.boolean(), companies: z.array(z.object({ id: z.string(), name: z.string(), wholeCompany: z.boolean(), sites: z.array(named) })) })
export type RuleChoices = z.infer<typeof choicesSchema>

/** What a rule's save sends (a change sends only what changed, with the version read). */
export interface RuleBody {
  threshold?: Threshold
  severity?: AlertSeverity
  companyId?: string | null
  siteId?: string | null
  recipientRoleId?: string | null
  channels?: AlertChannel[]
  cooldownMinutes?: number
  enabled?: boolean
}

export function listRules(api: ApiClient, query: { trigger?: RuleTrigger } = {}, signal?: AbortSignal): Promise<RulesList> {
  return api.get('/alerts/rules', { query: { trigger: query.trigger }, schema: rulesSchema, signal })
}

export async function getRule(api: ApiClient, id: string, signal?: AbortSignal): Promise<AlertRule> {
  return (await api.get(`/alerts/rules/${encodeURIComponent(id)}`, { schema: z.object({ rule: ruleSchema }), signal })).rule
}

/** POST /alerts/rules: a new rule of a kind (alerts.rules.manage over its place). */
export async function createRule(api: ApiClient, body: RuleBody & { ruleKind: RuleKind }): Promise<AlertRule> {
  return (await api.post('/alerts/rules', { body, schema: z.object({ rule: ruleSchema }), idempotencyKey: newIdempotencyKey() })).rule
}

/** PUT /alerts/rules/:id: what changed, with the version read (409 on a stale one). */
export async function updateRule(api: ApiClient, rule: Pick<AlertRule, 'id' | 'version'>, body: RuleBody): Promise<AlertRule> {
  return (await api.request('PUT', `/alerts/rules/${encodeURIComponent(rule.id)}`, { body: { version: rule.version, ...body }, schema: z.object({ rule: ruleSchema }), idempotencyKey: newIdempotencyKey() })).rule
}

/** POST /alerts/rules/:id/test: what these numbers and this place find now (nothing is saved). */
export function testRule(api: ApiClient, id: string, body: { threshold?: Threshold; companyId?: string | null; siteId?: string | null }): Promise<RuleTest> {
  return api.post(`/alerts/rules/${encodeURIComponent(id)}/test`, { body, schema: testSchema })
}

/** GET /alerts/rules/:id/timers: a date rule's timers, the waiting ones first (alerts.rules.manage). */
export async function ruleTimers(api: ApiClient, id: string, signal?: AbortSignal): Promise<RuleTimer[]> {
  return (await api.get(`/alerts/rules/${encodeURIComponent(id)}/timers`, { schema: z.object({ timers: z.array(timerSchema) }), signal })).timers
}

/** GET /alerts/rules/choices: the roles a rule may tell and the places the reader may keep rules for. */
export function ruleChoices(api: ApiClient, signal?: AbortSignal): Promise<RuleChoices> {
  return api.get('/alerts/rules/choices', { schema: choicesSchema, signal })
}
