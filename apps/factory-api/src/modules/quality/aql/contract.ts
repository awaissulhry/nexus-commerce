import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { CODE_LETTERS, INSPECTION_LEVELS, LOT_SIZE_MAX } from '@nexus/factory-domain/quality/aql/iso2859'
import { PROFILE_LIMITS, PROFILE_SOURCES } from '@nexus/factory-domain/quality/aql/profiles'
import { DEFECT_CLASSES_AQL } from '@nexus/factory-domain/quality/aql/sampling'

/**
 * The AQL engine and profiles of B-W2b-93 (QHS-013, QHS-020, QHS-021): the contracts of profiles.ts, assignments.ts,
 * chain.ts, calculator.ts and inspections.ts. Words are checked in factory-domain quality/aql (answers in words at
 * `body/<field>` or `query/<field>`); the lengths here only stop oversized bodies. No money anywhere. An AQL travels as
 * text, as Table 2-A prints it ("2.5", "0.65", "0").
 */

const version = z.number().int().min(1)
const level = z.enum(INSPECTION_LEVELS)
const letter = z.enum(CODE_LETTERS)
const klass = z.enum(DEFECT_CLASSES_AQL)
const source = z.enum(PROFILE_SOURCES)
const aqlText = () => z.string().max(12)
const itEn = () => output({ it: z.string(), en: z.string() })
const reason = () => z.string().max(PROFILE_LIMITS.reason * 2)
const lotSize = () => z.coerce.number().int().min(1).max(LOT_SIZE_MAX)

// ---- the plan and the result (shared) -------------------------------------------------------------------------------

export const planView = output({
  lotSize: z.number().int(),
  level,
  /** As ISO 2859-1 writes it ("II", "S-3"). */
  levelText: z.string(),
  /** Table 1's letter for the lot; null for a lot of 1 (inspected whole). */
  codeLetter: letter.nullable(),
  sampleSize: z.number().int(),
  hundredPercent: z.boolean(),
  samplesDiffer: z.boolean(),
  classes: z.array(
    output({
      defectClass: klass,
      aql: z.string(),
      accept: z.number().int(),
      reject: z.number().int(),
      /** The class's own plan in Table 2-A (after an arrow); null for AQL 0. */
      planLetter: letter.nullable(),
      planSampleSize: z.number().int().nullable(),
      arrow: z.enum(['down', 'up']).nullable(),
      locked: z.boolean(),
    }),
  ),
  words: z.string(),
  classWords: z.array(z.string()),
})
export type PlanView = z.infer<typeof planView>

export const resultView = output({
  verdict: z.enum(['open', 'accept', 'reject']),
  classes: z.array(
    output({
      defectClass: klass,
      aql: z.string(),
      accept: z.number().int(),
      reject: z.number().int(),
      found: z.number().int(),
      state: z.enum(['ok', 'limit', 'reject']),
      spare: z.number().int().nullable(),
      words: z.string(),
    }),
  ),
  progress: output({ inspected: z.number().int(), sampleSize: z.number().int(), remaining: z.number().int(), words: z.string() }).nullable(),
  resultNow: z.enum(['PASS', 'FAIL']),
  reasons: z.array(z.string()),
  byCountsOnly: z.boolean(),
  blockers: z.array(z.string()),
  overrideWords: z.string(),
  words: z.string(),
})
export type ResultView = z.infer<typeof resultView>

const criticalLock = output({ aql: z.string(), accept: z.number().int(), reject: z.number().int(), rule: itEn(), law: z.string() })

// ---- profiles (QHS-021) ---------------------------------------------------------------------------------------------

export const profileView = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  inspectionLevel: level,
  levelText: z.string(),
  levelWords: itEn(),
  /** Always "0" (QHS-002). */
  aqlCritical: z.string(),
  aqlMajor: z.string(),
  aqlMinor: z.string(),
  isDefault: z.boolean(),
  active: z.boolean(),
  note: z.string().nullable(),
  /** Active assignments naming it: customers only, styles only, a style of one customer. */
  usedBy: output({ customers: z.number().int(), styles: z.number().int(), pairs: z.number().int() }),
  /** Inspections (final) that took their plan from it. */
  inspections: z.number().int(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type ProfileView = z.infer<typeof profileView>

export const profilesContract = defineContract({
  querystring: input({ companyId: id().optional(), active: z.enum(['true', 'false']).optional() }),
  response: {
    200: output({
      profiles: z.array(profileView),
      levels: z.array(output({ level, text: z.string(), it: z.string(), en: z.string() })),
      /** The AQLs a major or minor may take: 0 and the columns of Table 2-A up to 10. */
      aqlValues: z.array(z.string()),
      criticalLock,
      /** The companies of the answer the caller may keep profiles of. */
      manageCompanyIds: z.array(id()),
    }),
  },
})

export const createProfileContract = defineContract({
  body: input({
    companyId: id(),
    code: z.string().max(80),
    name: z.string().max(PROFILE_LIMITS.name * 2),
    inspectionLevel: z.string().max(10),
    aqlMajor: aqlText(),
    aqlMinor: aqlText(),
    aqlCritical: aqlText().optional(),
    isDefault: z.boolean().optional(),
    note: z.string().max(PROFILE_LIMITS.note * 2).nullable().optional(),
  }),
  response: { 201: output({ profile: profileView, previousDefaultId: id().nullable() }) },
})

export const editProfileContract = defineContract({
  params: input({ profileId: id() }),
  body: input({
    version,
    code: z.string().max(80).optional(),
    name: z.string().max(PROFILE_LIMITS.name * 2).optional(),
    inspectionLevel: z.string().max(10).optional(),
    aqlMajor: aqlText().optional(),
    aqlMinor: aqlText().optional(),
    aqlCritical: aqlText().optional(),
    note: z.string().max(PROFILE_LIMITS.note * 2).nullable().optional(),
    active: z.boolean().optional(),
    /** true: this profile becomes the company's default (the old one stops being it). */
    isDefault: z.literal(true).optional(),
  }),
  response: { 200: output({ profile: profileView, previousDefaultId: id().nullable() }) },
})

// ---- assignments (QHS-021) ------------------------------------------------------------------------------------------

export const assignmentView = output({
  id: id(),
  companyId: id(),
  profileId: id(),
  profileCode: z.string(),
  customer: output({ id: id(), name: z.string().nullable() }).nullable(),
  style: output({ id: id(), code: z.string().nullable(), name: z.string().nullable() }).nullable(),
  active: z.boolean(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type AssignmentView = z.infer<typeof assignmentView>

export const assignmentsContract = defineContract({
  querystring: input({ companyId: id().optional(), profileId: id().optional(), customerId: id().optional(), styleId: id().optional(), active: z.enum(['true', 'false']).optional() }),
  response: { 200: output({ assignments: z.array(assignmentView) }) },
})

export const assignContract = defineContract({
  body: input({ profileId: id(), customerId: id().nullable().optional(), styleId: id().nullable().optional() }),
  response: { 201: output({ assignment: assignmentView, replacedId: id().nullable() }) },
})

export const endAssignmentContract = defineContract({
  params: input({ assignmentId: id() }),
  body: input({ version }),
  response: { 200: output({ assignment: assignmentView }) },
})

// ---- which profile applies (QHS-021) --------------------------------------------------------------------------------

export const chainView = output({
  profile: output({ id: id(), code: z.string(), name: z.string(), inspectionLevel: level, aqlMajor: z.string(), aqlMinor: z.string() }).nullable(),
  source,
  sourceWords: itEn(),
  steps: z.array(output({ source, profileId: id().nullable(), profileCode: z.string().nullable(), assignmentId: id().nullable(), skipped: z.string().nullable() })),
  words: z.string(),
})
export type ChainView = z.infer<typeof chainView>

export const resolveContract = defineContract({
  querystring: input({ companyId: id(), customerId: id().optional(), styleId: id().optional() }),
  response: { 200: output({ chain: chainView }) },
})

// ---- the calculator (QHS-020) ---------------------------------------------------------------------------------------

export const calculateContract = defineContract({
  querystring: input({
    lotSize: lotSize(),
    /** A profile's level and AQLs; or `level`, `aqlMajor`, `aqlMinor` typed (they win over the profile's). */
    profileId: id().optional(),
    level: z.string().max(10).optional(),
    aqlMajor: aqlText().optional(),
    aqlMinor: aqlText().optional(),
    /** What was found so far and how many were inspected: the result in words (optional). */
    critical: z.coerce.number().int().min(0).max(LOT_SIZE_MAX).optional(),
    major: z.coerce.number().int().min(0).max(LOT_SIZE_MAX).optional(),
    minor: z.coerce.number().int().min(0).max(LOT_SIZE_MAX).optional(),
    inspected: z.coerce.number().int().min(0).max(LOT_SIZE_MAX).optional(),
  }),
  response: { 200: output({ profile: output({ id: id(), code: z.string(), name: z.string() }).nullable(), plan: planView, result: resultView.nullable() }) },
})

// ---- a work order's plan, an inspection's Sample & AQL, applying a profile (QHS-013, QHS-021) ---------------------------

export const workOrderPlanContract = defineContract({
  params: input({ workOrderId: id() }),
  querystring: input({ lotSize: lotSize(), profileId: id().optional() }),
  response: {
    200: output({
      workOrderId: id(),
      number: z.string(),
      chain: chainView,
      /** The profile the plan is made from: the chain's, or the one asked for. */
      profileId: id().nullable(),
      named: z.boolean(),
      plan: planView.nullable(),
    }),
  },
})

export const inspectionAqlView = output({
  inspection: output({
    id: id(),
    number: z.string().nullable(),
    workOrderId: id(),
    status: z.string(),
    lotSize: z.number().int(),
    sampleSize: z.number().int(),
    inspectionLevel: z.string(),
    codeLetter: z.string().nullable(),
    aqlMajor: z.string(),
    aqlMinor: z.string(),
    acceptMajor: z.number().int(),
    acceptMinor: z.number().int(),
    planVersionId: id().nullable(),
    version: z.number().int(),
  }),
  /** The profile its plan came from; null: typed by hand (W1). */
  profile: output({ id: id(), code: z.string(), name: z.string(), active: z.boolean() }).nullable(),
  /** The profile that applies now (the chain), to compare or to apply. */
  chain: chainView,
  /** The plan the engine gives for its lot and profile (null without a profile or with a level it cannot read). */
  plan: planView.nullable(),
  /** The stored numbers are the engine's for its profile; null without a profile. */
  matchesProfile: z.boolean().nullable(),
  differences: z.array(z.string()),
  /** Counting started (a defect, a result or a measurement): the profile and code letter are frozen. */
  frozen: z.boolean(),
  frozenWords: z.string().nullable(),
  /** The plan version samples a fixed number of units: no AQL profile applies. */
  fixedSample: z.boolean(),
  /** Units with a defect of each class, from the inspection's defects. */
  counts: output({ critical: z.number().int(), major: z.number().int(), minor: z.number().int() }),
  /** The automatic result now (QHS-013); a decided inspection also has what the database wrote. */
  result: resultView,
  computedResult: z.enum(['PASS', 'FAIL']).nullable(),
  overrideReason: z.string().nullable(),
  /** The caller may apply a profile now (its inspector, OPEN, not frozen, not a fixed sample). */
  mayApply: z.boolean(),
  /** The derivation as the design's sentence ("Lot 480 garments · general level II → code letter H → inspect 50."). */
  words: z.string(),
})

export const inspectionAqlContract = defineContract({
  params: input({ inspectionId: id() }),
  response: { 200: inspectionAqlView },
})

export const applyProfileContract = defineContract({
  params: input({ inspectionId: id() }),
  body: input({
    version,
    /** Null or left out: the profile the chain gives. Another one needs `reason`. */
    profileId: id().nullable().optional(),
    /** A new lot size (W1's limits: the work order's finished garments). Left out: the inspection's. */
    lotSize: z.number().int().min(1).max(LOT_SIZE_MAX).optional(),
    reason: reason().nullable().optional(),
  }),
  response: { 200: inspectionAqlView },
})
