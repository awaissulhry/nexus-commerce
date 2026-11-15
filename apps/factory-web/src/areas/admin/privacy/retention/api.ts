import { z } from 'zod'
import { RETENTION_ACTIONS, RULE_HELD, SWEEP_FAILURES, SWEEP_HELD, SWEEP_MODES, SWEEP_STATUSES, WAITING_LEDGERS, type RetentionAction } from '@nexus/factory-domain/privacy/retention/retention'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Retention rules and their sweeps (B-W2b-414 on B-W2b-405's API, apps/factory-api platform/privacy/retention; PLT-204; GDPR art.
 * 5(1)(e)): every call of Admin › Privacy › Retention rules. The API's English (a type's "counts from" and "does", a period in
 * words, the UNVERIFIED sentence, each held code's words) is left out: the screen words them from the record type and the codes.
 * A rule's legal reason is a person's own text and is shown as written.
 */

const id = z.string()
const coded = <Codes extends readonly [string, ...string[]]>(codes: Codes) => z.object({ code: z.enum(codes) })
const may = z.object({ allowed: z.boolean(), held: coded(RULE_HELD).nullable() })
const action = z.enum(RETENTION_ACTIONS)

export const sweepSchema = z.object({
  id,
  ruleId: id,
  mode: z.enum(SWEEP_MODES),
  keepMonths: z.number(),
  thenAction: action,
  cutoffOn: z.string(),
  status: z.enum(SWEEP_STATUSES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  due: z.number(),
  applied: z.number(),
  held: z.number(),
  failed: z.number(),
  heldWhy: coded(SWEEP_HELD).nullable(),
  failures: z.array(z.object({ code: z.enum(SWEEP_FAILURES), recordId: z.string().nullable() })),
  requestedBy: z.object({ id, name: z.string() }).nullable(),
})
export type Sweep = z.infer<typeof sweepSchema>

export const ruleSchema = z.object({
  id,
  key: z.string(),
  company: z.object({ id, code: z.string(), name: z.string() }).nullable(),
  recordType: z.string(),
  known: z.boolean(),
  keepMonths: z.number(),
  thenAction: action,
  legalReason: z.string(),
  active: z.boolean(),
  applyOn: z.boolean(),
  applyOnAt: z.string().nullable(),
  applyOnBy: z.object({ id, name: z.string() }).nullable(),
  unverified: z.boolean(),
  holdsAll: coded(SWEEP_HELD).nullable(),
  version: z.number(),
  lastSweep: sweepSchema.nullable(),
  actions: z.object({ change: may, switchOff: may, switchOn: may, applyOn: may, applyOff: may, sweepNow: may }),
})
export type Rule = z.infer<typeof ruleSchema>
export type RuleActionName = keyof Rule['actions']

const typeSchema = z.object({ recordType: z.string(), companyScoped: z.boolean(), actions: z.array(action), holdsAll: coded(SWEEP_HELD).nullable() })
export type RetentionType = z.infer<typeof typeSchema>

const listAnswer = z.object({
  rules: z.array(ruleSchema),
  types: z.array(typeSchema),
  ledgers: z.array(z.object({ recordType: z.enum(WAITING_LEDGERS) })),
  datedPurges: z.array(z.object({ key: z.string(), job: z.string(), recordType: z.string() })),
  keptForGood: z.array(z.string()),
  sweep: z.object({ schedule: z.string() }),
})
export type RetentionList = z.infer<typeof listAnswer>
const ruleAnswer = z.object({ rule: ruleSchema })
const sweepAnswer = z.object({ rule: ruleSchema, sweep: sweepSchema })

const at = (ruleId: string, rest = '') => `/privacy/retention/rules/${encodeURIComponent(ruleId)}${rest}`
const key = (idempotencyKey?: string) => ({ idempotencyKey: idempotencyKey ?? newIdempotencyKey() })

/** The rules of the company (and the group's), the record types a rule may name, the ledgers kept, the dated purges. */
export const listRetention = (api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<RetentionList> =>
  api.get('/privacy/retention', { query: { companyId: companyId ?? undefined }, schema: listAnswer, signal })

export const listSweeps = (api: ApiClient, ruleId: string, signal?: AbortSignal): Promise<Sweep[]> => api.get(at(ruleId, '/sweeps'), { schema: z.object({ sweeps: z.array(sweepSchema) }), signal }).then((answer) => answer.sweeps)

export interface NewRuleBody {
  readonly companyId: string | null
  readonly recordType: string
  readonly keepMonths: number
  readonly thenAction: RetentionAction
  readonly legalReason: string
}

export const createRule = (api: ApiClient, body: NewRuleBody, idempotencyKey?: string): Promise<Rule> => api.post('/privacy/retention/rules', { body, schema: z.object({ rule: ruleSchema }), ...key(idempotencyKey) }).then((answer) => answer.rule)

/** Shortening the period, or another action while it applies, asks a fresh code (403 `stepUp`). */
export const changeRule = (api: ApiClient, rule: Pick<Rule, 'id' | 'version'>, change: { keepMonths?: number; thenAction?: RetentionAction; legalReason?: string }, idempotencyKey?: string): Promise<Rule> =>
  api.request('PATCH', at(rule.id), { body: { version: rule.version, ...change }, schema: ruleAnswer, ...key(idempotencyKey) }).then((answer) => answer.rule)

/** Off also stops applying. */
export const setRuleActive = (api: ApiClient, rule: Pick<Rule, 'id' | 'version'>, active: boolean, idempotencyKey?: string): Promise<Rule> =>
  api.post(at(rule.id, '/active'), { body: { version: rule.version, active }, schema: ruleAnswer, ...key(idempotencyKey) }).then((answer) => answer.rule)

/** On asks a fresh code (GATE-PRIVACY: nothing is deleted until a person switches a rule on). */
export const setRuleApply = (api: ApiClient, rule: Pick<Rule, 'id' | 'version'>, on: boolean, idempotencyKey?: string): Promise<Rule> =>
  api.post(at(rule.id, '/apply'), { body: { version: rule.version, on }, schema: ruleAnswer, ...key(idempotencyKey) }).then((answer) => answer.rule)

/** One sweep now: it reports, or applies when the rule is switched on. */
export const sweepNow = (api: ApiClient, ruleId: string, idempotencyKey?: string) => api.post(at(ruleId, '/sweep'), { body: {}, schema: sweepAnswer, ...key(idempotencyKey) })
