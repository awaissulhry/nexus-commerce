import { z } from 'zod'
import { EVIDENCE_KINDS, LIMIT_BOUNDS, RULE_CODES, RULE_SOURCES, SUBSTANCE_LISTS, SUBSTANCE_STATUSES, SUBSTANCE_TESTS, SUBSTANCE_UNITS, DECLARATION_KINDS } from '@nexus/factory-domain/compliance/substances/rules'
import { PLAN_STATUSES, TEST_FREQUENCIES } from '@nexus/factory-domain/compliance/test-plans/rules'
import type { ApiClient } from '../../../../lib/api/client'

/**
 * Every call of Compliance › Tests & substances › Substance list, its rules and the test plan rules (B-W2b-267 on B-W2b-250's
 * API, modules/compliance/substances, and B-W2b-256's, modules/compliance/test-plans): the substances with the rules that
 * restrict each, the starter list of public law, the rules with their switch (an OFF rule with its reason), the Candidate
 * List versions, and the test plan rules (create, edit, archive, switch). Each answer's shape is checked (zod mirrors of the
 * API's contracts). The API's English (`limit`, `sourceWords`, `frequencyWords`) is read but shown only where it is data (a
 * limit's figure and unit); the screens say their own words from the codes. No money.
 */

const seg = (value: string) => encodeURIComponent(value)
const person = z.object({ id: z.string(), name: z.string() }).nullable()

const ruleRef = z.object({
  id: z.string(),
  key: z.string(),
  code: z.enum(RULE_CODES),
  name: z.string(),
  limitValue: z.string().nullable(),
  limitUnit: z.enum(SUBSTANCE_UNITS).nullable(),
  limitBound: z.enum(LIMIT_BOUNDS).nullable(),
  materialKinds: z.array(z.string()),
  testMethod: z.string().nullable(),
  source: z.enum(RULE_SOURCES),
  switchedOn: z.boolean(),
  status: z.enum(SUBSTANCE_STATUSES),
})
export type RuleRef = z.infer<typeof ruleRef>

export const substanceSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  casNumber: z.string().nullable(),
  ecNumber: z.string().nullable(),
  name: z.string(),
  nameI18n: z.record(z.string(), z.string()),
  groupCode: z.string().nullable(),
  lists: z.array(z.enum(SUBSTANCE_LISTS)),
  annexXviiEntries: z.array(z.string()),
  svhcListVersion: z.object({ id: z.string(), publishedOn: z.string() }).nullable(),
  note: z.string().nullable(),
  status: z.enum(SUBSTANCE_STATUSES),
  rules: z.array(ruleRef),
  version: z.number().int(),
})
export type Substance = z.infer<typeof substanceSchema>
export type SubstanceList = (typeof SUBSTANCE_LISTS)[number]

const substancesSchema = z.object({ substances: z.array(substanceSchema), more: z.boolean(), asOf: z.string(), mayManage: z.boolean() })
export type SubstancesAnswer = z.infer<typeof substancesSchema>

export interface SubstanceQuery {
  readonly list?: SubstanceList | null
  readonly status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | null
  readonly q?: string | null
}

/** GET /compliance/substances (compliance.certificates.view): up to 2000 substances with the ACTIVE rules restricting each. */
export const listSubstances = (api: ApiClient, query: SubstanceQuery, signal?: AbortSignal): Promise<SubstancesAnswer> =>
  api.get('/compliance/substances', { query: { list: query.list ?? undefined, status: query.status ?? undefined, q: query.q?.trim() || undefined }, schema: substancesSchema, signal })

const starterSchema = z.object({ substances: z.object({ added: z.number().int(), kept: z.number().int() }), rules: z.object({ added: z.number().int(), kept: z.number().int() }) })
export type StarterAnswer = z.infer<typeof starterSchema>

/** POST /compliance/substances/starter (compliance.substances.manage over every company): what is missing of public law. */
export const loadStarter = (api: ApiClient, idempotencyKey: string): Promise<StarterAnswer> => api.post('/compliance/substances/starter', { body: {}, schema: starterSchema, idempotencyKey })

export const ruleSchema = ruleRef.extend({
  companyId: z.string().nullable(),
  substance: z.object({ id: z.string(), casNumber: z.string().nullable(), name: z.string(), status: z.enum(SUBSTANCE_STATUSES) }).nullable(),
  substanceGroup: z.string().nullable(),
  members: z.number().int(),
  productTypes: z.array(z.string()),
  marketCodes: z.array(z.string()),
  evidence: z.enum(EVIDENCE_KINDS),
  exemptPpe: z.boolean(),
  exemptNaturalLeather: z.boolean(),
  customer: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  legalReference: z.string(),
  legalUrl: z.string().nullable(),
  offReason: z.string().nullable(),
  switchedAt: z.string().nullable(),
  switchedBy: person,
  test: z.enum(SUBSTANCE_TESTS).nullable(),
  declaration: z.enum(DECLARATION_KINDS),
  version: z.number().int(),
})
export type SubstanceRule = z.infer<typeof ruleSchema>

const rulesSchema = z.object({ rules: z.array(ruleSchema), asOf: z.string(), mayManage: z.boolean() })
export type RulesAnswer = z.infer<typeof rulesSchema>

/** GET /compliance/substances/rules: every rule (ACTIVE by default) with its switch and the reason it is off. */
export const listRules = (api: ApiClient, query: { q?: string | null; status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | null }, signal?: AbortSignal): Promise<RulesAnswer> =>
  api.get('/compliance/substances/rules', { query: { q: query.q?.trim() || undefined, status: query.status ?? undefined }, schema: rulesSchema, signal })

/** PUT /compliance/substances/rules/:id/switch (compliance.substances.manage): off with the reason (3–500), on without. */
export const switchRule = (api: ApiClient, rule: Pick<SubstanceRule, 'id' | 'version'>, on: boolean, reason: string | null, idempotencyKey: string): Promise<{ rule: SubstanceRule }> =>
  api.request('PUT', `/compliance/substances/rules/${seg(rule.id)}/switch`, { body: { version: rule.version, on, reason: on ? null : (reason ?? '').trim() }, schema: z.object({ rule: ruleSchema }), idempotencyKey })

export const versionSchema = z.object({
  id: z.string(),
  publishedOn: z.string(),
  entryCount: z.number().int(),
  source: z.string(),
  sourceUrl: z.string().nullable(),
  note: z.string().nullable(),
  substancesAdded: z.number().int(),
  grewBy: z.number().int().nullable(),
  newest: z.boolean(),
  version: z.number().int(),
})
export type CandidateListVersion = z.infer<typeof versionSchema>

const versionsSchema = z.object({ versions: z.array(versionSchema), asOf: z.string(), mayManage: z.boolean() })
export type VersionsAnswer = z.infer<typeof versionsSchema>

/** GET /compliance/substances/svhc-versions: the ECHA Candidate List versions recorded, newest first. */
export const listVersions = (api: ApiClient, signal?: AbortSignal): Promise<VersionsAnswer> => api.get('/compliance/substances/svhc-versions', { schema: versionsSchema, signal })

/** POST /compliance/substances/svhc-versions (over every company): a new version of the list, never in the future, one per day. */
export const createVersion = (api: ApiClient, body: { publishedOn: string; entryCount: number; source: string; sourceUrl: string | null; note: string | null }, idempotencyKey: string): Promise<{ version: CandidateListVersion }> =>
  api.post('/compliance/substances/svhc-versions', { body, schema: z.object({ version: versionSchema }), idempotencyKey })

// ---- test plan rules --------------------------------------------------------------------------------------------------

export const planSchema = z.object({
  id: z.string(),
  companyId: z.string().nullable(),
  itemKind: z.string().nullable(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string(), kind: z.string() }).nullable(),
  test: z.enum(SUBSTANCE_TESTS),
  frequency: z.enum(TEST_FREQUENCIES),
  marketCode: z.string().nullable(),
  substanceRule: z.object({ id: z.string(), key: z.string(), code: z.string(), name: z.string(), limit: z.string(), switchedOn: z.boolean(), status: z.string() }).nullable(),
  method: z.string().nullable(),
  switchedOn: z.boolean(),
  offReason: z.string().nullable(),
  switchedAt: z.string().nullable(),
  switchedBy: person,
  note: z.string().nullable(),
  status: z.enum(PLAN_STATUSES),
  version: z.number().int(),
})
export type TestPlan = z.infer<typeof planSchema>

const plansSchema = z.object({ plans: z.array(planSchema), mayManage: z.boolean(), asOf: z.string() })
export type PlansAnswer = z.infer<typeof plansSchema>

/** GET /compliance/test-plans: the plan rules (ACTIVE by default; `ALL` with the archived ones). */
export const listPlans = (api: ApiClient, query: { status?: 'ACTIVE' | 'ARCHIVED' | 'ALL' | null }, signal?: AbortSignal): Promise<PlansAnswer> =>
  api.get('/compliance/test-plans', { query: { status: query.status ?? undefined }, schema: plansSchema, signal })

export interface PlanBody {
  readonly itemKind: string | null
  readonly itemId: string | null
  readonly test: (typeof SUBSTANCE_TESTS)[number]
  readonly frequency: (typeof TEST_FREQUENCIES)[number]
  readonly marketCode: string | null
  readonly substanceRuleId: string | null
  readonly method: string | null
  readonly note: string | null
}

/** POST /compliance/test-plans (compliance.substances.manage): a new plan rule, on (off needs its reason). */
export const createPlan = (api: ApiClient, body: PlanBody & { companyId: string | null; switchedOn: boolean; offReason: string | null }, idempotencyKey: string): Promise<{ plan: TestPlan }> =>
  api.post('/compliance/test-plans', { body, schema: z.object({ plan: planSchema }), idempotencyKey })

/** PATCH /compliance/test-plans/:id: edit (a kind replaces the material and back), archive or restore by `status`. */
export const editPlan = (api: ApiClient, plan: Pick<TestPlan, 'id' | 'version'>, body: Partial<PlanBody> & { status?: 'ACTIVE' | 'ARCHIVED' }, idempotencyKey: string): Promise<{ plan: TestPlan }> =>
  api.request('PATCH', `/compliance/test-plans/${seg(plan.id)}`, { body: { version: plan.version, ...body }, schema: z.object({ plan: planSchema }), idempotencyKey })

/** PUT /compliance/test-plans/:id/switch: off with the reason, on without. */
export const switchPlan = (api: ApiClient, plan: Pick<TestPlan, 'id' | 'version'>, on: boolean, reason: string | null, idempotencyKey: string): Promise<{ plan: TestPlan }> =>
  api.request('PUT', `/compliance/test-plans/${seg(plan.id)}/switch`, { body: { version: plan.version, on, reason: on ? null : (reason ?? '').trim() }, schema: z.object({ plan: planSchema }), idempotencyKey })
