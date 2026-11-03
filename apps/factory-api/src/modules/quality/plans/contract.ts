import { z } from 'zod'
import { defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DEFECT_CLASSES } from '@nexus/factory-domain/quality/defects/rules'
import { CHECK_TYPES, CHIP_KINDS, FREQUENCIES, PLAN_LIMITS, PLAN_STAGES, SAMPLING_METHODS, VERSION_STATUSES } from '@nexus/factory-domain/quality/plans/rules'
import { UOMS } from '@nexus/factory-domain/product/units/units'

/**
 * Inspection plans (B-W2b-92; QHS-008, QHS-009, QHS-016): the contracts of ./plans.ts (reads) and ./commands.ts (writes).
 * The rules and their words are factory-domain quality/plans (answers in words at `body/<field>`); the lengths here only
 * stop oversized bodies. No money anywhere.
 */

const version = z.number().int().min(1)
const stage = z.enum(PLAN_STAGES)
const status = z.enum(VERSION_STATUSES)
const itEn = () => output({ it: z.string(), en: z.string() })
const text = (max: number) => z.string().max(max * 2)
const person = output({ id: id(), name: z.string() }).nullable()
const chipIn = input({ kind: z.enum(CHIP_KINDS), value: z.string().max(80) })
const chipsIn = z.array(chipIn).max(PLAN_LIMITS.chips * 2)
const issue = output({ path: z.string(), message: z.string() })

// ---- shared views ------------------------------------------------------------------------------------------------------

export const chipView = output({
  kind: z.enum(CHIP_KINDS),
  value: z.string(),
  /** What it names, in words ("JKT-01 Moto jacket", "Jackets"); "?" when the record is out of sight or gone. */
  label: z.string(),
  kindWords: itEn(),
})

export const samplingView = output({
  samplingMethod: z.enum(SAMPLING_METHODS),
  aqlProfileId: id().nullable(),
  /** The profile named, as it is now (B-W2b-93 keeps the profiles); null: the one that applies when a record opens. */
  profile: output({ id: id(), code: z.string(), name: z.string(), inspectionLevel: z.string(), aqlMajor: z.string(), aqlMinor: z.string(), active: z.boolean() }).nullable(),
  fixedSampleSize: z.number().int().nullable(),
  frequency: z.enum(FREQUENCIES).nullable(),
  frequencyValue: z.number().int().nullable(),
  stopAtReject: z.boolean().nullable(),
  words: output({ sample: itEn(), frequency: itEn().nullable(), stop: itEn() }),
})

export const checkView = output({
  id: id(),
  sortOrder: z.number().int(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  type: z.enum(CHECK_TYPES),
  typeWords: itEn(),
  takesResult: z.boolean(),
  checkClass: z.enum(DEFECT_CLASSES).nullable(),
  mandatory: z.boolean(),
  photoRequired: z.boolean(),
  nominal: z.string().nullable(),
  tolerance: z.string().nullable(),
  uom: z.enum(UOMS).nullable(),
  choices: z.array(z.string()),
  /** "58.000 ± 1.000 cm" or the size chart; null for other types. */
  spec: itEn().nullable(),
})

const usage = output({ final: z.number().int(), incoming: z.number().int(), inProcess: z.number().int(), records: z.number().int() })

export const versionView = output({
  id: id(),
  planId: id(),
  number: z.number().int(),
  status,
  statusWords: itEn(),
  changeNote: z.string().nullable(),
  author: person,
  approvedBy: person,
  approvedAt: instant().nullable(),
  approvalSha256: z.string().nullable(),
  retiredBy: person,
  retiredAt: instant().nullable(),
  sampling: samplingView,
  checks: z.array(checkView),
  /** The records that ran on it (QHS-016), as far as the caller's sites reach. */
  usedBy: usage,
  /** The draft's author asked for approval (and nothing was saved since): who and when. */
  submitted: output({ by: person, at: instant(), note: z.string().nullable() }).nullable(),
  /** What stops this draft from being approved, whoever approves it (empty: nothing); null when not a draft. */
  problems: z.array(issue).nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})
export type VersionView = z.infer<typeof versionView>

export const versionRow = output({
  id: id(),
  number: z.number().int(),
  status,
  statusWords: itEn(),
  changeNote: z.string().nullable(),
  author: person,
  approvedBy: person,
  approvedAt: instant().nullable(),
  retiredAt: instant().nullable(),
  checks: z.number().int(),
  usedBy: usage,
  createdAt: instant(),
})

export const planRow = output({
  id: id(),
  companyId: id(),
  code: z.string(),
  name: z.string(),
  stage,
  stageWords: itEn(),
  appliesTo: z.array(chipView),
  /** The version new records run on; null: none approved. */
  approved: output({ id: id(), number: z.number().int() }).nullable(),
  /** The draft being written, if any. */
  draft: output({ id: id(), number: z.number().int(), submitted: z.boolean() }).nullable(),
  /** The plan's state as the grid says it: APPROVED (a version in force), DRAFT (only drafts), RETIRED (none left). */
  status,
  statusWords: itEn(),
  latestNumber: z.number().int(),
  owner: person,
  usedBy: z.number().int(),
  lastChangeAt: instant(),
  version: z.number().int(),
})
export type PlanRow = z.infer<typeof planRow>

const may = output({
  manage: z.boolean(),
  approve: z.boolean(),
  /** Why this person may not approve the draft now (the author, an editor, no right), in words; null when they may. */
  approveHeld: z.string().nullable(),
})

export const comparisonView = output({
  fromNumber: z.number().int().nullable(),
  toNumber: z.number().int(),
  added: z.array(output({ code: z.string(), labelIt: z.string(), labelEn: z.string() })),
  removed: z.array(output({ code: z.string(), labelIt: z.string(), labelEn: z.string() })),
  changed: z.array(output({ code: z.string(), changes: z.array(output({ field: z.string(), before: z.unknown(), after: z.unknown() })) })),
  moved: z.array(z.string()),
  sampling: z.array(output({ field: z.string(), before: z.unknown(), after: z.unknown() })),
  same: z.boolean(),
})

export const planRecord = output({
  plan: planRow,
  versions: z.array(versionRow),
  /** The version the builder opens: the draft, else the approved one, else the latest. */
  current: versionView,
  /** The current version against the approved one (none approved: against nothing). */
  comparison: comparisonView,
  /** "applies to 14 styles" (materials for an incoming plan): what the chips reach in the company now. */
  preview: output({ subject: z.enum(['styles', 'materials']), count: z.number().int(), outOf: z.number().int() }),
  /** Active rules of "When inspections are created" that name the plan. */
  rules: z.number().int(),
  may,
})

// ---- reads -------------------------------------------------------------------------------------------------------------

export const listContract = defineContract({
  querystring: input({
    companyId: id().optional(),
    stage: stage.optional(),
    status: status.optional(),
    q: z.string().max(80).optional(),
  }),
  response: {
    200: output({
      plans: z.array(planRow),
      /** At most 500 plans per company: true when more matched. */
      truncated: z.boolean(),
      counts: output({ byStage: z.record(z.string(), z.number().int()), waitingApproval: z.number().int() }),
      stages: z.array(output({ stage, it: z.string(), en: z.string() })),
      canManage: z.boolean(),
      canApprove: z.boolean(),
    }),
  },
})

export const recordContract = defineContract({ params: input({ planId: id() }), response: { 200: planRecord } })

export const versionContract = defineContract({
  params: input({ planId: id(), versionId: id() }),
  querystring: input({ compare: id().optional() }),
  response: {
    200: output({
      version: versionView,
      comparison: comparisonView,
      /** The newest records that ran on it (up to 50): the kind, its number (an in-process check has none) and state. */
      records: z.array(output({ kind: z.enum(['FINAL', 'INCOMING', 'IN_PROCESS']), id: id(), number: z.string().nullable(), status: z.string(), siteId: id(), at: instant() })),
      may,
    }),
  },
})

const language = z.string().regex(/^[a-z]{2,3}$/)

export const checklistContract = defineContract({
  params: input({ planId: id(), versionId: id() }),
  querystring: input({ language: language.optional() }),
  response: {
    200: output({
      language: z.string(),
      title: z.string(),
      subtitle: z.string(),
      notInForce: z.string().nullable(),
      lines: z.array(output({ label: z.string(), value: z.string() })),
      rows: z.array(
        output({
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
      /** The languages a bench may print it in: it, en and the company's sites' floor languages. */
      languages: z.array(z.string()),
    }),
  },
})

export const frozenContract = defineContract({
  params: input({ versionId: id() }),
  querystring: input({ language: language.optional() }),
  response: {
    200: output({
      plan: output({ id: id(), code: z.string(), name: z.string(), stage, stageWords: itEn() }),
      version: output({ id: id(), number: z.number().int(), status, statusWords: itEn(), approvedAt: instant().nullable(), approvalSha256: z.string().nullable() }),
      sampling: samplingView,
      checks: z.array(checkView.extend({ label: z.string(), missing: z.boolean() })),
      language: z.string(),
    }),
  },
})

export const starterContract = defineContract({
  querystring: input({ companyId: id() }),
  response: {
    200: output({
      plans: z.array(output({ code: z.string(), stage, stageWords: itEn(), name: itEn(), checks: z.number().int(), missing: z.boolean() })),
    }),
  },
})

// ---- writes ------------------------------------------------------------------------------------------------------------

const checkIn = input({
  code: z.string().max(80),
  labelIt: text(PLAN_LIMITS.label),
  labelEn: text(PLAN_LIMITS.label),
  labelI18n: z.record(z.string().max(8), text(PLAN_LIMITS.label)).optional(),
  type: z.enum(CHECK_TYPES),
  checkClass: z.enum(DEFECT_CLASSES).nullable().optional(),
  mandatory: z.boolean().optional(),
  photoRequired: z.boolean().optional(),
  nominal: z.string().max(20).nullable().optional(),
  tolerance: z.string().max(20).nullable().optional(),
  uom: z.enum(UOMS).nullable().optional(),
  choices: z.array(z.string().max(PLAN_LIMITS.choice * 2)).max(PLAN_LIMITS.choices * 2).optional(),
})

const samplingIn = input({
  samplingMethod: z.enum(SAMPLING_METHODS),
  aqlProfileId: id().nullable().optional(),
  fixedSampleSize: z.number().int().nullable().optional(),
  frequency: z.enum(FREQUENCIES).nullable().optional(),
  frequencyValue: z.number().int().nullable().optional(),
  stopAtReject: z.boolean().nullable().optional(),
})

const startFrom = z.discriminatedUnion('kind', [
  input({ kind: z.literal('BLANK') }),
  input({ kind: z.literal('STARTER'), code: z.string().max(80) }),
  input({ kind: z.literal('COPY'), versionId: id() }),
])

export const createContract = defineContract({
  body: input({
    companyId: id(),
    code: z.string().max(80),
    stage,
    name: text(PLAN_LIMITS.name),
    ownerId: id().nullable().optional(),
    appliesTo: chipsIn.optional(),
    startFrom: startFrom.optional(),
  }),
  response: { 201: planRecord },
})

export const editContract = defineContract({
  params: input({ planId: id() }),
  body: input({ version, name: text(PLAN_LIMITS.name).optional(), ownerId: id().nullable().optional(), appliesTo: chipsIn.optional() }),
  response: { 200: planRecord },
})

export const draftContract = defineContract({
  params: input({ planId: id() }),
  body: input({ version, fromVersionId: id().optional(), changeNote: text(PLAN_LIMITS.changeNote).nullable().optional() }),
  response: { 201: output({ version: versionView }) },
})

export const saveContract = defineContract({
  params: input({ planId: id(), versionId: id() }),
  body: input({
    version,
    changeNote: text(PLAN_LIMITS.changeNote).nullable().optional(),
    sampling: samplingIn.optional(),
    /** The whole list in its new order: codes kept are changed, new codes added, codes left out removed. */
    checks: z.array(checkIn).max(PLAN_LIMITS.checks * 2).optional(),
  }),
  response: { 200: output({ version: versionView }) },
})

export const submitContract = defineContract({
  params: input({ planId: id(), versionId: id() }),
  body: input({ version, note: text(PLAN_LIMITS.reason).nullable().optional() }),
  response: { 200: output({ version: versionView }) },
})

export const approveContract = defineContract({
  params: input({ planId: id(), versionId: id() }),
  body: input({ version }),
  response: { 200: output({ version: versionView, retired: output({ id: id(), number: z.number().int() }).nullable() }) },
})

export const retireContract = defineContract({
  params: input({ planId: id(), versionId: id() }),
  body: input({ version, reason: text(PLAN_LIMITS.reason) }),
  response: { 200: output({ version: versionView }) },
})

export const addStarterContract = defineContract({
  body: input({ companyId: id(), language: z.enum(['it', 'en']).optional(), codes: z.array(z.string().max(80)).max(20).optional() }),
  response: { 200: output({ added: z.array(output({ planId: id(), code: z.string(), versionId: id() })) }) },
})
