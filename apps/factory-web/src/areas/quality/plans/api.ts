import { z } from 'zod'
import { CODE_LETTERS, INSPECTION_LEVELS } from '@nexus/factory-domain/quality/aql/iso2859'
import type { ApiClient } from '../../../lib/api/client'
import { CHECK_CLASSES, CHECK_TYPES, CHIP_KINDS, FREQUENCIES, PLAN_STAGES, RECORD_KINDS, SAMPLING_METHODS, TRIGGER_EVENTS, VERSION_STATUSES } from './constants'

/**
 * Every call of Quality › Settings › Inspection plans & AQL (SCR-077) and the plan record (SCR-077-plan), with the answer's
 * shape checked (zod; unknown fields dropped). The shapes mirror apps/factory-api modules/quality/plans (B-W2b-92),
 * modules/quality/aql (B-W2b-93) and modules/quality/triggers (B-W2b-101). Each write carries the version read and an
 * Idempotency-Key per attempt; approving a version asks for a fresh code (403 `stepUp`: the step-up dialog, then the same
 * call again). The API's English sentences are dropped where the screen says its own words from codes and figures; the
 * it/en pairs the domain writes (a held event, a skip, a preview) are kept and shown in the page's language.
 */

const stage = z.enum(PLAN_STAGES)
const status = z.enum(VERSION_STATUSES)
const itEn = z.object({ it: z.string(), en: z.string() })
const person = z.object({ id: z.string(), name: z.string() }).nullable()
const level = z.enum(INSPECTION_LEVELS)

export const chipSchema = z.object({ kind: z.enum(CHIP_KINDS), value: z.string(), label: z.string() })
export type ChipView = z.infer<typeof chipSchema>

const samplingSchema = z.object({
  samplingMethod: z.enum(SAMPLING_METHODS),
  aqlProfileId: z.string().nullable(),
  profile: z.object({ id: z.string(), code: z.string(), name: z.string(), inspectionLevel: z.string(), aqlMajor: z.string(), aqlMinor: z.string(), active: z.boolean() }).nullable(),
  fixedSampleSize: z.number().int().nullable(),
  frequency: z.enum(FREQUENCIES).nullable(),
  frequencyValue: z.number().int().nullable(),
  stopAtReject: z.boolean().nullable(),
})
export type SamplingView = z.infer<typeof samplingSchema>

export const checkSchema = z.object({
  id: z.string(),
  sortOrder: z.number().int(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  type: z.enum(CHECK_TYPES),
  checkClass: z.enum(CHECK_CLASSES).nullable(),
  mandatory: z.boolean(),
  photoRequired: z.boolean(),
  nominal: z.string().nullable(),
  tolerance: z.string().nullable(),
  uom: z.string().nullable(),
  choices: z.array(z.string()),
})
export type CheckView = z.infer<typeof checkSchema>

const usage = z.object({ final: z.number().int(), incoming: z.number().int(), inProcess: z.number().int(), records: z.number().int() })
const issue = z.object({ path: z.string(), message: z.string() })

export const versionSchema = z.object({
  id: z.string(),
  planId: z.string(),
  number: z.number().int(),
  status,
  changeNote: z.string().nullable(),
  author: person,
  approvedBy: person,
  approvedAt: z.string().nullable(),
  approvalSha256: z.string().nullable(),
  retiredBy: person,
  retiredAt: z.string().nullable(),
  sampling: samplingSchema,
  checks: z.array(checkSchema),
  usedBy: usage,
  submitted: z.object({ by: person, at: z.string(), note: z.string().nullable() }).nullable(),
  problems: z.array(issue).nullable(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type VersionView = z.infer<typeof versionSchema>

const versionRow = z.object({
  id: z.string(),
  number: z.number().int(),
  status,
  changeNote: z.string().nullable(),
  author: person,
  approvedBy: person,
  approvedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
  checks: z.number().int(),
  usedBy: usage,
  createdAt: z.string(),
})
export type VersionRow = z.infer<typeof versionRow>

export const planRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  stage,
  appliesTo: z.array(chipSchema),
  approved: z.object({ id: z.string(), number: z.number().int() }).nullable(),
  draft: z.object({ id: z.string(), number: z.number().int(), submitted: z.boolean() }).nullable(),
  status,
  latestNumber: z.number().int(),
  owner: person,
  usedBy: z.number().int(),
  lastChangeAt: z.string(),
  version: z.number().int(),
})
export type PlanRow = z.infer<typeof planRowSchema>

const fieldChange = z.object({ field: z.string(), before: z.unknown(), after: z.unknown() })
const labelled = z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string() })
export const comparisonSchema = z.object({
  fromNumber: z.number().int().nullable(),
  toNumber: z.number().int(),
  added: z.array(labelled),
  removed: z.array(labelled),
  changed: z.array(z.object({ code: z.string(), changes: z.array(fieldChange) })),
  moved: z.array(z.string()),
  sampling: z.array(fieldChange),
  same: z.boolean(),
})
export type Comparison = z.infer<typeof comparisonSchema>

const maySchema = z.object({ manage: z.boolean(), approve: z.boolean(), approveHeld: z.string().nullable() })

export const planRecordSchema = z.object({
  plan: planRowSchema,
  versions: z.array(versionRow),
  current: versionSchema,
  comparison: comparisonSchema,
  preview: z.object({ subject: z.enum(['styles', 'materials']), count: z.number().int(), outOf: z.number().int() }),
  rules: z.number().int(),
  may: maySchema,
})
export type PlanRecord = z.infer<typeof planRecordSchema>

const plansAnswer = z.object({
  plans: z.array(planRowSchema),
  truncated: z.boolean(),
  counts: z.object({ byStage: z.record(z.string(), z.number().int()), waitingApproval: z.number().int() }),
  canManage: z.boolean(),
  canApprove: z.boolean(),
})
export type PlansAnswer = z.infer<typeof plansAnswer>

export interface PlansQuery {
  companyId?: string
  stage?: string
  status?: string
  q?: string
}

/** GET /quality/plans (quality.plans.view): the Plans grid of the address's company. */
export const readPlans = (api: ApiClient, query: PlansQuery, signal?: AbortSignal) =>
  api.get('/quality/plans', { query: { companyId: query.companyId, stage: query.stage || undefined, status: query.status || undefined, q: query.q?.trim() || undefined }, schema: plansAnswer, signal })

const starterSchema = z.object({ plans: z.array(z.object({ code: z.string(), stage, name: itEn, checks: z.number().int(), missing: z.boolean() })) })
export type Starter = z.infer<typeof starterSchema>['plans'][number]

/** GET /quality/plans/starter (quality.plans.view): the leather-apparel starter set, each plan missing or not. */
export const readStarter = (api: ApiClient, companyId: string) => api.get('/quality/plans/starter', { query: { companyId }, schema: starterSchema })

/** POST /quality/plans/starter (quality.plans.manage): the missing starter plans as drafts, in the person's language. */
export const addStarter = (api: ApiClient, body: { companyId: string; language: 'it' | 'en'; codes?: string[] }, idempotencyKey: string) =>
  api.post('/quality/plans/starter', { body, schema: z.object({ added: z.array(z.object({ planId: z.string(), code: z.string(), versionId: z.string() })) }), idempotencyKey })

export type StartFrom = { kind: 'BLANK' } | { kind: 'STARTER'; code: string } | { kind: 'COPY'; versionId: string }

export interface CreatePlanBody {
  companyId: string
  code: string
  stage: (typeof PLAN_STAGES)[number]
  name: string
  ownerId?: string | null
  appliesTo?: { kind: (typeof CHIP_KINDS)[number]; value: string }[]
  startFrom?: StartFrom
}

/** POST /quality/plans (quality.plans.manage): a new plan with version 1 as a draft by the caller. */
export const createPlan = (api: ApiClient, body: CreatePlanBody, idempotencyKey: string) => api.post('/quality/plans', { body, schema: planRecordSchema, idempotencyKey })

/** GET /quality/plans/:planId (quality.plans.view): the record. */
export const readPlan = (api: ApiClient, planId: string, signal?: AbortSignal) => api.get(`/quality/plans/${encodeURIComponent(planId)}`, { schema: planRecordSchema, signal })

export interface EditPlanBody {
  version: number
  name?: string
  ownerId?: string | null
  appliesTo?: { kind: (typeof CHIP_KINDS)[number]; value: string }[]
}

/** PATCH /quality/plans/:planId (quality.plans.manage): name, owner, applies to. */
export const editPlan = (api: ApiClient, planId: string, body: EditPlanBody, idempotencyKey: string) =>
  api.request('PATCH', `/quality/plans/${encodeURIComponent(planId)}`, { body, schema: planRecordSchema, idempotencyKey })

/** POST /quality/plans/:planId/versions (quality.plans.manage): the next draft, copied from the approved version. */
export const draftVersion = (api: ApiClient, planId: string, body: { version: number; changeNote?: string | null }, idempotencyKey: string) =>
  api.post(`/quality/plans/${encodeURIComponent(planId)}/versions`, { body, schema: z.object({ version: versionSchema }), idempotencyKey })

const versionRecordSchema = z.object({
  version: versionSchema,
  comparison: comparisonSchema,
  records: z.array(z.object({ kind: z.enum(['FINAL', 'INCOMING', 'IN_PROCESS']), id: z.string(), number: z.string().nullable(), status: z.string(), siteId: z.string(), at: z.string() })),
  may: maySchema,
})
export type VersionRecord = z.infer<typeof versionRecordSchema>

/** GET /quality/plans/:planId/versions/:versionId?compare= (quality.plans.view): one version, compared, and the records on it. */
export const readVersion = (api: ApiClient, planId: string, versionId: string, compare: string | null, signal?: AbortSignal) =>
  api.get(`/quality/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}`, { query: { compare: compare ?? undefined }, schema: versionRecordSchema, signal })

export interface CheckBody {
  code: string
  labelIt: string
  labelEn: string
  labelI18n?: Record<string, string>
  type: (typeof CHECK_TYPES)[number]
  checkClass: (typeof CHECK_CLASSES)[number] | null
  mandatory: boolean
  photoRequired: boolean
  nominal: string | null
  tolerance: string | null
  uom: string | null
  choices: string[]
}

export interface SamplingBody {
  samplingMethod: (typeof SAMPLING_METHODS)[number]
  aqlProfileId: string | null
  fixedSampleSize: number | null
  frequency: (typeof FREQUENCIES)[number] | null
  frequencyValue: number | null
  stopAtReject: boolean | null
}

export interface SaveVersionBody {
  version: number
  changeNote?: string | null
  sampling?: SamplingBody
  checks?: CheckBody[]
}

/** PUT /quality/plans/:planId/versions/:versionId (quality.plans.manage): the builder's save of a draft (the WHOLE list). */
export const saveVersion = (api: ApiClient, planId: string, versionId: string, body: SaveVersionBody, idempotencyKey: string) =>
  api.request('PUT', `/quality/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}`, { body, schema: z.object({ version: versionSchema }), idempotencyKey })

/** POST …/submit (quality.plans.manage): the author asks for approval. */
export const submitVersion = (api: ApiClient, planId: string, versionId: string, body: { version: number; note?: string | null }, idempotencyKey: string) =>
  api.post(`/quality/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}/submit`, { body, schema: z.object({ version: versionSchema }), idempotencyKey })

/** POST …/approve (quality.plans.approve + a fresh code): a second person approves; the version in force is retired. */
export const approveVersion = (api: ApiClient, planId: string, versionId: string, body: { version: number }, idempotencyKey: string) =>
  api.post(`/quality/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}/approve`, {
    body,
    schema: z.object({ version: versionSchema, retired: z.object({ id: z.string(), number: z.number().int() }).nullable() }),
    idempotencyKey,
  })

/** POST …/retire (quality.plans.manage): a draft nobody wants, or the version in force, with the reason. */
export const retireVersion = (api: ApiClient, planId: string, versionId: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  api.post(`/quality/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}/retire`, { body, schema: z.object({ version: versionSchema }), idempotencyKey })

export const checklistSchema = z.object({
  language: z.string(),
  title: z.string(),
  subtitle: z.string(),
  notInForce: z.string().nullable(),
  lines: z.array(z.object({ label: z.string(), value: z.string() })),
  rows: z.array(
    z.object({
      n: z.number().int(),
      code: z.string(),
      label: z.string(),
      missing: z.boolean(),
      type: z.string(),
      takesResult: z.boolean(),
      klass: z.string().nullable(),
      critical: z.boolean(),
      mandatory: z.boolean(),
      photoRequired: z.boolean(),
      spec: z.string().nullable(),
      answer: z.string(),
      choices: z.array(z.string()),
    }),
  ),
  sampleColumns: z.number().int(),
  signatures: z.array(z.string()),
  legend: z.string(),
  languages: z.array(z.string()),
})
export type Checklist = z.infer<typeof checklistSchema>

/** GET …/checklist?language= (quality.plans.view): the printable checklist in a bench's language. */
export const readChecklist = (api: ApiClient, planId: string, versionId: string, language: string | null, signal?: AbortSignal) =>
  api.get(`/quality/plans/${encodeURIComponent(planId)}/versions/${encodeURIComponent(versionId)}/checklist`, { query: { language: language ?? undefined }, schema: checklistSchema, signal })

// ---- AQL profiles, assignments, the calculator (B-W2b-93) ---------------------------------------------------------------

export const profileSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  code: z.string(),
  name: z.string(),
  inspectionLevel: level,
  aqlCritical: z.string(),
  aqlMajor: z.string(),
  aqlMinor: z.string(),
  isDefault: z.boolean(),
  active: z.boolean(),
  note: z.string().nullable(),
  usedBy: z.object({ customers: z.number().int(), styles: z.number().int(), pairs: z.number().int() }),
  inspections: z.number().int(),
  version: z.number().int(),
  updatedAt: z.string(),
})
export type Profile = z.infer<typeof profileSchema>

const profilesAnswer = z.object({
  profiles: z.array(profileSchema),
  aqlValues: z.array(z.string()),
  criticalLock: z.object({ aql: z.string(), accept: z.number().int(), reject: z.number().int(), law: z.string() }),
  manageCompanyIds: z.array(z.string()),
})
export type ProfilesAnswer = z.infer<typeof profilesAnswer>

/** GET /quality/aql/profiles?companyId (quality.aql.view). */
export const readProfiles = (api: ApiClient, companyId: string | undefined, signal?: AbortSignal) => api.get('/quality/aql/profiles', { query: { companyId }, schema: profilesAnswer, signal })

export interface CreateProfileBody {
  companyId: string
  code: string
  name: string
  inspectionLevel: string
  aqlMajor: string
  aqlMinor: string
  isDefault?: boolean
  note?: string | null
}

const profileAnswer = z.object({ profile: profileSchema, previousDefaultId: z.string().nullable() })

/** POST /quality/aql/profiles (quality.aql.manage). */
export const createProfile = (api: ApiClient, body: CreateProfileBody, idempotencyKey: string) => api.post('/quality/aql/profiles', { body, schema: profileAnswer, idempotencyKey })

export interface EditProfileBody {
  version: number
  name?: string
  inspectionLevel?: string
  aqlMajor?: string
  aqlMinor?: string
  note?: string | null
  active?: boolean
  isDefault?: true
}

/** PATCH /quality/aql/profiles/:profileId (quality.aql.manage). */
export const editProfile = (api: ApiClient, profileId: string, body: EditProfileBody, idempotencyKey: string) =>
  api.request('PATCH', `/quality/aql/profiles/${encodeURIComponent(profileId)}`, { body, schema: profileAnswer, idempotencyKey })

export const assignmentSchema = z.object({
  id: z.string(),
  profileId: z.string(),
  profileCode: z.string(),
  customer: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  style: z.object({ id: z.string(), code: z.string().nullable(), name: z.string().nullable() }).nullable(),
  active: z.boolean(),
  version: z.number().int(),
})
export type Assignment = z.infer<typeof assignmentSchema>

/** GET /quality/aql/assignments?profileId&active=true (quality.aql.view). */
export const readAssignments = (api: ApiClient, profileId: string, signal?: AbortSignal) =>
  api.get('/quality/aql/assignments', { query: { profileId, active: 'true' }, schema: z.object({ assignments: z.array(assignmentSchema) }), signal })

/** POST /quality/aql/assignments (quality.aql.manage): the profile for a customer, a style, or a style of one customer. */
export const assignProfile = (api: ApiClient, body: { profileId: string; customerId: string | null; styleId: string | null }, idempotencyKey: string) =>
  api.post('/quality/aql/assignments', { body, schema: z.object({ assignment: assignmentSchema, replacedId: z.string().nullable() }), idempotencyKey })

/** POST /quality/aql/assignments/:id/end (quality.aql.manage). */
export const endAssignment = (api: ApiClient, assignmentId: string, version: number, idempotencyKey: string) =>
  api.post(`/quality/aql/assignments/${encodeURIComponent(assignmentId)}/end`, { body: { version }, schema: z.object({ assignment: assignmentSchema }), idempotencyKey })

export const planViewSchema = z.object({
  lotSize: z.number().int(),
  level,
  codeLetter: z.enum(CODE_LETTERS).nullable(),
  sampleSize: z.number().int(),
  hundredPercent: z.boolean(),
  samplesDiffer: z.boolean(),
  classes: z.array(
    z.object({
      defectClass: z.enum(CHECK_CLASSES),
      aql: z.string(),
      accept: z.number().int(),
      reject: z.number().int(),
      planLetter: z.enum(CODE_LETTERS).nullable(),
      planSampleSize: z.number().int().nullable(),
      arrow: z.enum(['down', 'up']).nullable(),
      locked: z.boolean(),
    }),
  ),
})
export type AqlPlanView = z.infer<typeof planViewSchema>

export interface CalculateAsk {
  lotSize: number
  profileId?: string | null
  level?: string | null
  aqlMajor?: string | null
  aqlMinor?: string | null
}

/** GET /quality/aql/calculate (quality.aql.view): the plan of a lot (AqlSummary's data). Nothing is saved. */
export const calculate = (api: ApiClient, ask: CalculateAsk, signal?: AbortSignal) =>
  api.get('/quality/aql/calculate', {
    query: { lotSize: ask.lotSize, profileId: ask.profileId || undefined, level: ask.level || undefined, aqlMajor: ask.aqlMajor || undefined, aqlMinor: ask.aqlMinor || undefined },
    schema: z.object({ profile: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), plan: planViewSchema }),
    signal,
  })

// ---- When inspections are created (B-W2b-101) ------------------------------------------------------------------------

const event = z.enum(TRIGGER_EVENTS)

export const ruleSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  position: z.number().int(),
  sortOrder: z.number().int(),
  event,
  appliesTo: z.array(chipSchema),
  plan: z.object({ id: z.string(), code: z.string(), name: z.string(), stage, approved: z.object({ id: z.string(), number: z.number().int() }).nullable(), appliesTo: z.array(chipSchema) }),
  frequency: z.enum(FREQUENCIES),
  frequencyValue: z.number().int().nullable(),
  recordKind: z.enum(RECORD_KINDS).nullable(),
  active: z.boolean(),
  opened: z.object({ last30Days: z.number().int(), lastAt: z.string().nullable() }),
  skipped: z.object({ last30Days: z.number().int(), lastAt: z.string().nullable(), lastWords: itEn.nullable() }),
  version: z.number().int(),
})
export type Rule = z.infer<typeof ruleSchema>

export const eventInfoSchema = z.object({
  event,
  available: z.boolean(),
  held: itEn.nullable(),
  stages: z.array(stage),
  frequencies: z.array(z.object({ frequency: z.enum(FREQUENCIES), takesValue: z.boolean() })),
  chipKinds: z.array(z.enum(CHIP_KINDS)),
})
export type EventInfo = z.infer<typeof eventInfoSchema>

const rulesAnswer = z.object({ rules: z.array(ruleSchema), events: z.array(eventInfoSchema), canManage: z.boolean() })
export type RulesAnswer = z.infer<typeof rulesAnswer>

/** GET /quality/inspection-triggers?companyId (quality.triggers.view): the rules in order and the events' matrix. */
export const readRules = (api: ApiClient, companyId: string | undefined, signal?: AbortSignal) => api.get('/quality/inspection-triggers', { query: { companyId }, schema: rulesAnswer, signal })

export interface RuleBody {
  event: (typeof TRIGGER_EVENTS)[number]
  planId: string
  appliesTo: { kind: (typeof CHIP_KINDS)[number]; value: string }[]
  frequency: (typeof FREQUENCIES)[number]
  frequencyValue: number | null
  active: boolean
}

/** POST /quality/inspection-triggers (quality.triggers.manage). */
export const createRule = (api: ApiClient, body: RuleBody & { companyId: string; position?: number }, idempotencyKey: string) =>
  api.post('/quality/inspection-triggers', { body, schema: z.object({ rule: ruleSchema }), idempotencyKey })

/** PATCH /quality/inspection-triggers/:id (quality.triggers.manage). */
export const editRule = (api: ApiClient, ruleId: string, body: Partial<RuleBody> & { version: number }, idempotencyKey: string) =>
  api.request('PATCH', `/quality/inspection-triggers/${encodeURIComponent(ruleId)}`, { body, schema: z.object({ rule: ruleSchema }), idempotencyKey })

/** DELETE /quality/inspection-triggers/:id?version (quality.triggers.manage): its records keep their plan version. */
export const deleteRule = (api: ApiClient, ruleId: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `/quality/inspection-triggers/${encodeURIComponent(ruleId)}`, { query: { version }, schema: z.object({ deleted: z.object({ id: z.string() }) }), idempotencyKey })

/** POST /quality/inspection-triggers/order (quality.triggers.manage): every rule's id once, in the new order. */
export const orderRules = (api: ApiClient, body: { companyId: string; order: string[] }, idempotencyKey: string) =>
  api.post('/quality/inspection-triggers/order', { body, schema: z.object({ rules: z.array(ruleSchema) }), idempotencyKey })

const previewAnswer = z.object({ preview: z.object({ considered: z.number().int(), fits: z.number().int(), earlier: z.number().int(), opened: z.number().int(), from: z.string(), to: z.string(), truncated: z.boolean(), words: itEn }) })
export type RulePreview = z.infer<typeof previewAnswer>['preview']

/** POST /quality/inspection-triggers/preview (quality.triggers.view): what the unsaved rule would have opened last month. */
export const previewRule = (api: ApiClient, body: Omit<RuleBody, 'active'> & { companyId: string; triggerId?: string; position?: number }) => api.post('/quality/inspection-triggers/preview', { body, schema: previewAnswer })

// ---- pickers for "Applies to" ------------------------------------------------------------------------------------------

/** One record a chip may name: its id and the words a chip shows (code · name). */
export interface PickOption {
  id: string
  label: string
}

const coded = z.object({ id: z.string(), code: z.string(), name: z.string() })
const party = z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })

/** Styles, materials, operations, suppliers or customers matching the words typed (each list's own view right). */
export async function pickRecords(api: ApiClient, kind: 'STYLE' | 'MATERIAL' | 'OPERATION' | 'SUPPLIER' | 'CUSTOMER', q: string, signal?: AbortSignal): Promise<PickOption[]> {
  const query = { q: q.trim() || undefined, limit: 20 }
  const named = (row: { id: string; code: string; name: string }) => ({ id: row.id, label: `${row.code} · ${row.name}` })
  switch (kind) {
    case 'STYLE':
      return (await api.get('/product/styles', { query, schema: z.object({ styles: z.array(coded) }), signal })).styles.map(named)
    case 'MATERIAL':
      return (await api.get('/product/materials', { query, schema: z.object({ materials: z.array(coded) }), signal })).materials.map(named)
    case 'OPERATION':
      return (await api.get('/product/operations', { query, schema: z.object({ operations: z.array(coded) }), signal })).operations.map(named)
    default: {
      const role = kind === 'SUPPLIER' ? 'SUPPLIER,SUBCONTRACTOR' : 'CUSTOMER,BRAND'
      const answer = await api.get('/parties', { query: { ...query, role }, schema: z.object({ parties: z.array(party) }), signal })
      return answer.parties.map((row) => ({ id: row.id, label: `${row.code} · ${row.tradeName ?? row.legalName}` }))
    }
  }
}
