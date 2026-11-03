import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { JOB_STATUSES, JOB_TYPES, MACHINE_STATUSES, PLANT_LIMITS, PRIORITIES } from '@nexus/factory-domain/plant/rules'
import { CHECK_INTERVAL_UNITS, CHECK_LIMITS, CHECK_OUTCOMES, CHECK_PLAN_STATUSES, DUE_STATES, LEAST_RETENTION_YEARS, MAX_RETENTION_YEARS } from '@nexus/factory-domain/plant/statutory/rules'
import { fileView, presignedView } from '../../../platform/files/contract'
import { jobOut, machineOut, requestOut } from '../contract'

/**
 * The routes of the statutory periodic checks (B-W2b-124; QHS-205; design plant.preventive, plant.settings "Statutory check
 * types"). Days are `YYYY-MM-DD` (Europe/Rome). A check rule's refusal is a 409 with the issues `refusal/<CODE>`
 * (factory-domain plant/statutory/rules STATUTORY_REFUSALS) and `fix`; a plant rule's from the requests and jobs it makes
 * (PLANT_REFUSALS, DEPTH_REFUSALS). People: office users `{ id, name }`; who did a check is words, as on the report.
 */

const version = () => z.number().int().min(1)
const text = (max: number) => z.string().trim().min(1).max(max)
const flag = () => z.enum(['true', 'false']).transform((value) => value === 'true')
const named = output({ id: id(), name: z.string().nullable() })
const site = output({ id: id(), code: z.string(), name: z.string() })
const machineBrief = output({ id: id(), assetNumber: z.string(), make: z.string().nullable(), modelName: z.string().nullable(), status: z.enum(MACHINE_STATUSES), classId: id(), siteId: id() })
const typeBrief = output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string(), legalBasis: z.string(), outsideBody: z.boolean(), keptYears: z.number().int(), active: z.boolean() })
const words = z.record(z.string(), z.string())
const wordsChange = z.record(z.string(), z.string().max(CHECK_LIMITS.label).nullable())
const limit = z.coerce.number().int().min(1).max(CHECK_LIMITS.page).default(100)

// ---- check types --------------------------------------------------------------------------------------------------------------

export const typeOut = output({
  id: id(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: words,
  /** The law or standard it rests on, in the office's words (LawRef). */
  legalBasis: z.string(),
  machineClass: output({ id: id(), code: z.string(), labelIt: z.string(), labelEn: z.string() }).nullable(),
  defaultInterval: z.number().int(),
  defaultIntervalUnit: z.enum(CHECK_INTERVAL_UNITS),
  outsideBody: z.boolean(),
  retentionYears: z.number().int(),
  keptYears: z.number().int(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  plans: z.number().int(),
  results: z.number().int(),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listTypesContract = defineContract({
  querystring: input({ active: flag().optional(), classId: id().optional() }),
  response: { 200: output({ types: z.array(typeOut), canManage: z.boolean(), leastRetentionYears: z.number().int() }) },
})

const typeFields = {
  labelIt: text(CHECK_LIMITS.label),
  labelEn: text(CHECK_LIMITS.label),
  labelI18n: wordsChange.optional(),
  legalBasis: text(CHECK_LIMITS.legalBasis),
  defaultInterval: z.number().int().min(1),
  defaultIntervalUnit: z.enum(CHECK_INTERVAL_UNITS),
  outsideBody: z.boolean().optional(),
  /** Results kept 3 to 30 years (D.Lgs. 81/2008 art. 71: at least 3); default 3. */
  retentionYears: z.number().int().min(LEAST_RETENTION_YEARS).max(MAX_RETENTION_YEARS).optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
}
const typeAnswer = output({ type: typeOut, replayed: z.boolean() })

export const createTypeContract = defineContract({
  body: input({ code: z.string().trim().min(1).max(40), ...typeFields, /** The class of machine it is for; null: any machine. Never changes. */ classId: id().nullable().optional() }),
  response: { 201: typeAnswer, 200: typeAnswer },
})

export const updateTypeContract = defineContract({
  params: input({ checkTypeId: id() }),
  body: input({
    version: version(),
    labelIt: typeFields.labelIt.optional(),
    labelEn: typeFields.labelEn.optional(),
    labelI18n: typeFields.labelI18n,
    legalBasis: typeFields.legalBasis.optional(),
    defaultInterval: typeFields.defaultInterval.optional(),
    defaultIntervalUnit: typeFields.defaultIntervalUnit.optional(),
    outsideBody: typeFields.outsideBody,
    retentionYears: typeFields.retentionYears,
    sortOrder: typeFields.sortOrder,
    /** false retires it (no new plan), true makes it active again. */
    active: z.boolean().optional(),
  }),
  response: { 200: typeAnswer },
})

// ---- plans ------------------------------------------------------------------------------------------------------------------------

export const planOut = output({
  id: id(),
  companyId: id(),
  site,
  machine: machineBrief.extend({ locked: z.boolean() }),
  checkType: typeBrief,
  interval: z.number().int(),
  intervalUnit: z.enum(CHECK_INTERVAL_UNITS),
  outsideBody: named.nullable(),
  owner: named.nullable(),
  firstDueOn: businessDate(),
  nextDueOn: businessDate(),
  reminderDays: z.number().int(),
  /** The first day of the reminder window (next due − lead time). */
  reminderFrom: businessDate(),
  lastRemindedAt: instant().nullable(),
  lastDone: output({ resultId: id(), performedOn: businessDate(), outcome: z.enum(CHECK_OUTCOMES) }).nullable(),
  /** The tone: overdue, due within 30 days, planned later, or ended; `days` until due (negative: overdue). */
  due: output({ state: z.enum(DUE_STATES), days: z.number().int() }),
  status: z.enum(CHECK_PLAN_STATUSES),
  endedAt: instant().nullable(),
  endedReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})

export const listPlansContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    machineId: id().optional(),
    checkTypeId: id().optional(),
    /** Default ACTIVE. */
    status: z.enum(CHECK_PLAN_STATUSES).optional(),
    due: z.enum(['OVERDUE', 'DUE_SOON']).optional(),
    cursor: z.string().max(60).optional(),
    limit,
  }),
  response: { 200: output({ plans: z.array(planOut), nextCursor: z.string().nullable(), today: businessDate() }) },
})

const planAnswer = output({ plan: planOut, replayed: z.boolean() })

export const createPlanContract = defineContract({
  body: input({
    machineId: id(),
    checkTypeId: id(),
    /** Default: the type's default interval (both or neither). */
    interval: z.number().int().min(1).optional(),
    intervalUnit: z.enum(CHECK_INTERVAL_UNITS).optional(),
    outsideBodyPartyId: id().nullable().optional(),
    ownerId: id().nullable().optional(),
    firstDueOn: businessDate(),
    /** Days before the due date the reminder goes (0 to 365; default 30). */
    reminderDays: z.number().int().min(0).max(CHECK_LIMITS.reminderDays).optional(),
    note: z.string().trim().max(CHECK_LIMITS.note).nullable().optional(),
    /** End the ACTIVE plan of this machine and type in the same command, with this reason. */
    replaceReason: text(CHECK_LIMITS.reason).optional(),
  }),
  response: { 201: planAnswer.extend({ replacedPlanId: id().nullable() }), 200: planAnswer.extend({ replacedPlanId: id().nullable() }) },
})

const planParams = input({ planId: id() })

export const updatePlanContract = defineContract({
  params: planParams,
  body: input({
    version: version(),
    interval: z.number().int().min(1).optional(),
    intervalUnit: z.enum(CHECK_INTERVAL_UNITS).optional(),
    outsideBodyPartyId: id().nullable().optional(),
    ownerId: id().nullable().optional(),
    reminderDays: z.number().int().min(0).max(CHECK_LIMITS.reminderDays).optional(),
    note: z.string().trim().max(CHECK_LIMITS.note).nullable().optional(),
  }),
  response: { 200: planAnswer },
})

export const movePlanContract = defineContract({ params: planParams, body: input({ version: version(), nextDueOn: businessDate(), reason: text(CHECK_LIMITS.reason) }), response: { 200: planAnswer } })
export const endPlanContract = defineContract({ params: planParams, body: input({ version: version(), reason: text(CHECK_LIMITS.reason) }), response: { 200: planAnswer } })

// ---- results ------------------------------------------------------------------------------------------------------------------------

const reportFile = output({ id: id(), originalName: z.string(), contentType: z.string(), sizeBytes: z.number().int(), availableAt: instant().nullable() })
const jobBrief = output({ id: id(), number: z.string(), status: z.enum(JOB_STATUSES) })

export const resultOut = output({
  id: id(),
  companyId: id(),
  site,
  machine: machineBrief,
  checkType: typeBrief,
  planId: id().nullable(),
  performedOn: businessDate(),
  outcome: z.enum(CHECK_OUTCOMES),
  remarks: z.string().nullable(),
  /** Who did it, as on the report: the outside body or the inspector (words). */
  performedBy: z.string(),
  outsideBody: named.nullable(),
  nextDueOn: businessDate().nullable(),
  keptUntil: businessDate(),
  corrects: output({ id: id(), performedOn: businessDate() }).nullable(),
  correctionReason: z.string().nullable(),
  correctedBy: output({ id: id(), performedOn: businessDate() }).nullable(),
  inForce: z.boolean(),
  reports: z.array(reportFile),
  reportOnFile: z.boolean(),
  jobs: z.array(jobBrief),
  recordedAt: instant(),
  recordedBy: named.nullable(),
})

export const listResultsContract = defineContract({
  querystring: input({
    siteId: id().optional(),
    machineId: id().optional(),
    checkTypeId: id().optional(),
    planId: id().optional(),
    outcome: z.enum(CHECK_OUTCOMES).optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    inForce: flag().optional(),
    reportMissing: flag().optional(),
    cursor: z.string().max(60).optional(),
    limit,
  }),
  response: { 200: output({ results: z.array(resultOut), nextCursor: z.string().nullable(), today: businessDate(), from: businessDate().nullable(), to: businessDate().nullable() }) },
})

const jobAsk = input({
  type: z.enum(JOB_TYPES).optional(),
  priority: z.enum(PRIORITIES).optional(),
  problem: text(PLANT_LIMITS.text).optional(),
  assigneeId: id().nullable().optional(),
  assigneeWorkerId: id().nullable().optional(),
  dueAt: instant().nullable().optional(),
  plan: z.boolean().optional(),
})
const lockAsk = input({ note: text(PLANT_LIMITS.note).optional() })

const stepAnswer = output({ result: resultOut, plan: planOut.nullable(), job: jobOut.nullable(), lock: requestOut.nullable(), machine: machineOut, replayed: z.boolean() })

export const recordResultContract = defineContract({
  body: input({
    planId: id().optional(),
    machineId: id().optional(),
    checkTypeId: id().optional(),
    performedOn: businessDate(),
    outcome: z.enum(CHECK_OUTCOMES),
    remarks: z.string().max(CHECK_LIMITS.text).nullable().optional(),
    performedBy: z.string().max(CHECK_LIMITS.performedBy),
    outsideBodyPartyId: id().nullable().optional(),
    /** The next due date the check gives (after the day); none: the plan's interval decides. */
    nextDueOn: businessDate().nullable().optional(),
    correctsId: id().nullable().optional(),
    correctionReason: z.string().max(CHECK_LIMITS.reason).nullable().optional(),
    /** "Make a job" in the same step (a failed or remarked check). */
    job: jobAsk.optional(),
    /** "Lock as unsafe" in the same step (a failed check). */
    lock: lockAsk.optional(),
  }),
  response: { 201: stepAnswer, 200: stepAnswer },
})

const resultParams = input({ resultId: id() })

export const resultJobContract = defineContract({ params: resultParams, body: jobAsk, response: { 201: stepAnswer, 200: stepAnswer } })
export const resultLockContract = defineContract({ params: resultParams, body: lockAsk, response: { 201: stepAnswer, 200: stepAnswer } })

export const resultRecordContract = defineContract({
  params: resultParams,
  response: {
    200: output({
      result: resultOut,
      plan: planOut.nullable(),
      corrections: z.array(resultOut),
      machine: output({ id: id(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean() }),
      canCorrect: z.boolean(),
      canMakeJob: z.boolean(),
      canLock: z.boolean(),
      canAddReport: z.boolean(),
    }),
  },
})

export const planRecordContract = defineContract({
  params: planParams,
  response: { 200: output({ plan: planOut, results: z.array(resultOut), canManage: z.boolean(), canRecord: z.boolean() }) },
})

// ---- the page's reads ---------------------------------------------------------------------------------------------------------------

export const countsContract = defineContract({
  querystring: input({ siteId: id().optional() }),
  response: { 200: output({ tiles: output({ OVERDUE: z.number().int(), DUE_SOON: z.number().int(), REPORTS_MISSING: z.number().int() }), today: businessDate() }) },
})

export const calendarContract = defineContract({
  querystring: input({ from: businessDate(), to: businessDate(), siteId: id().optional() }),
  response: {
    200: output({
      from: businessDate(),
      to: businessDate(),
      today: businessDate(),
      chips: z.array(
        output({
          /** DUE: the plan's next due date; PROJECTED: a later check by its interval; DONE: a check done (in force). */
          kind: z.enum(['DUE', 'PROJECTED', 'DONE']),
          date: businessDate(),
          state: z.enum(['OVERDUE', 'DUE_SOON', 'PLANNED', 'DONE']),
          planId: id().nullable(),
          resultId: id().nullable(),
          site,
          machine: output({ id: id(), assetNumber: z.string(), status: z.enum(MACHINE_STATUSES), locked: z.boolean() }),
          checkType: typeBrief,
          outsideBody: z.string().nullable(),
          outcome: z.enum(CHECK_OUTCOMES).nullable(),
        }),
      ),
      canManage: z.boolean(),
    }),
  },
})

// ---- reports ---------------------------------------------------------------------------------------------------------------------------

export const announceReportContract = defineContract({
  params: resultParams,
  body: input({
    /** The body's or technician's report: a PDF (DOCUMENT) or a certificate (CERTIFICATE). */
    kind: z.enum(['DOCUMENT', 'CERTIFICATE']),
    originalName: z.string().min(1).max(500),
    contentType: z.string().min(1).max(200),
    sizeBytes: z.number().int().min(1),
    /** SHA-256 of the content, 64 lower-case hex digits. */
    sha256: z.string(),
  }),
  response: { 201: output({ file: fileView, upload: presignedView }) },
})
export const completeReportContract = defineContract({ params: resultParams.extend({ fileId: id() }), response: { 200: output({ file: fileView }) } })
export const downloadReportContract = defineContract({ params: resultParams.extend({ fileId: id() }), response: { 200: output({ download: presignedView }) } })

export const previewPdfContract = defineContract({ params: resultParams, querystring: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }), response: {} })
export const keepPdfContract = defineContract({
  params: resultParams,
  body: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }),
  response: {
    201: output({
      document: output({ id: id(), version: z.number().int(), language: z.string(), fileId: id(), createdAt: instant() }),
      /** False: the newest version already showed exactly this. */
      made: z.boolean(),
      replayed: z.boolean(),
    }),
  },
})
