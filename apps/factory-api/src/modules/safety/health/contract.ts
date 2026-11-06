import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import {
  FITNESS_OUTCOMES,
  HEALTH_LIMITS,
  HEALTH_VIEW_RECORDS,
  JUDGEMENT_STATES,
  PROPOSAL_REASONS,
  VIEW_WHATS,
  VISIT_CANCEL_REASONS,
  VISIT_STATES,
  VISIT_STATUSES,
  VISIT_TYPES,
  VOID_REASONS,
} from '@nexus/factory-domain/safety/health/rules'
import { fileView, presignedView } from '../../../platform/files/contract'
import { leaverOut } from '../../people/leavers/contract'

/**
 * Health surveillance (B-W2b-135; QHS-252, QHS-253, QHS-254, QHS-256; design plant.health SCR-212: the PrivacyNote, the tiles,
 * the due list, the judgements, the plans per role, the pop-ups Record a judgement, Plan visits, Mark booked, Who looked, the
 * windows "Visit list for the doctor" and "Judgement copy"). Names and health values only come from the routes that record the
 * view first (…/list, …/proposals, …/print, …/open, …/show); every other answer is ids, states, counts or a plan (no person in
 * it). A command's answer is ids and versions only: it is kept in its receipt. No money anywhere; nothing clinical exists.
 */

const L = HEALTH_LIMITS
const version = () => z.number().int().min(1)
const words = (longest: number) => z.string().trim().min(1).max(longest)
const codeName = output({ code: z.string(), name: z.string() })
const ref = output({ id: id(), code: z.string(), name: z.string() })
const person = output({ id: id(), name: z.string(), employeeCode: z.string().nullable(), siteId: id(), site: codeName })
const userRef = output({ id: id(), name: z.string() })
const wordsIt = output({ en: z.string(), it: z.string() })
const replayed = z.boolean()

// ---- the page ---------------------------------------------------------------------------------------------------------------

const scopeQuery = { companyId: id().optional(), siteId: id().optional() }

export const frameContract = defineContract({
  querystring: input(scopeQuery),
  response: {
    200: output({
      today: businessDate(),
      privacy: output({ words: wordsIt, law: z.string(), viewLog: z.boolean() }),
      liveUse: wordsIt,
      automatic: wordsIt,
      hint: wordsIt,
      tiles: output({ overdue: z.number().int(), dueIn30: z.number().int(), beforeTask: z.number().int(), returnVisits: z.number().int(), unfitEnding: z.number().int() }),
      can: output({ manage: z.boolean(), plans: z.boolean(), views: z.boolean() }),
      law: z.string(),
    }),
  },
})

// ---- plans per role (no person) ---------------------------------------------------------------------------------------------

export const planOut = output({
  id: id(),
  companyId: id(),
  siteId: id(),
  site: codeName,
  role: ref,
  needed: z.boolean(),
  frequencyMonths: z.number().int().nullable(),
  endOfEmploymentVisit: z.boolean(),
  setOn: businessDate(),
  doctor: userRef.nullable(),
  /** The doctor is recorded: visits plan themselves from this plan. */
  doctorSet: z.boolean(),
  /** The role sheet's surveillance needs: the risks driving it (typed once, on the role sheet). */
  risks: z.array(z.string()),
  /** ACTIVE people in the role: a count. */
  people: z.number().int(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  version: z.number().int(),
  canEdit: z.boolean(),
})

export const plansContract = defineContract({
  querystring: input({ ...scopeQuery, status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional() }),
  response: { 200: output({ plans: z.array(planOut), law: z.string() }) },
})

export const editPlanContract = defineContract({
  params: input({ planId: id() }),
  body: input({
    version: version(),
    frequencyMonths: z.number().int().min(L.frequencyMin).max(L.frequencyMax).optional(),
    endOfEmploymentVisit: z.boolean().optional(),
    doctorAppointmentId: id().nullable().optional(),
    setOn: businessDate().optional(),
  }),
  response: { 200: output({ plan: planOut, changed: z.boolean() }) },
})

// ---- visits -----------------------------------------------------------------------------------------------------------------

export const visitRowOut = output({
  id: id(),
  companyId: id(),
  employee: person,
  role: ref.nullable(),
  type: z.enum(VISIT_TYPES),
  dueOn: businessDate(),
  status: z.enum(VISIT_STATUSES),
  state: z.enum(VISIT_STATES),
  booked: output({ on: businessDate(), place: z.string().nullable() }).nullable(),
  doneOn: businessDate().nullable(),
  version: z.number().int(),
})

export const visitListContract = defineContract({
  body: input({
    ...scopeQuery,
    /** One person's visits (the Employee › Safety tab), still a recorded list. */
    employeeId: id().optional(),
    status: z.enum(['open', 'done', 'cancelled', 'all']).optional(),
    type: z.enum(VISIT_TYPES).optional(),
    from: businessDate().optional(),
    to: businessDate().optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(L.list).optional(),
  }),
  response: { 200: output({ today: businessDate(), visits: z.array(visitRowOut), more: z.boolean(), recorded: z.boolean() }) },
})

export const visitPrintContract = defineContract({
  body: input({ ...scopeQuery, visitIds: z.array(id()).min(1).max(L.list).optional() }),
  response: {
    200: output({
      today: businessDate(),
      visits: z.array(visitRowOut.extend({ risks: z.array(z.string()) })),
      recorded: z.boolean(),
      law: z.string(),
    }),
  },
})

export const proposalsContract = defineContract({
  body: input({ ...scopeQuery, employeeIds: z.array(id()).min(1).max(L.items).optional(), horizonDays: z.number().int().min(0).max(L.horizonMax).optional() }),
  response: {
    200: output({
      today: businessDate(),
      proposals: z.array(output({ employee: person, role: ref, planId: id(), type: z.enum(VISIT_TYPES), dueOn: businessDate(), why: z.enum(PROPOSAL_REASONS), doctorSet: z.boolean() })),
      recorded: z.boolean(),
    }),
  },
})

const visitIds = output({ visits: z.array(output({ id: id(), version: z.number().int(), status: z.enum(VISIT_STATUSES) })), replayed })

export const planVisitsContract = defineContract({
  body: input({
    items: z
      .array(
        input({
          employeeId: id(),
          type: z.enum(VISIT_TYPES),
          dueOn: businessDate(),
          roleSheetId: id().optional(),
          absenceDays: z.number().int().min(1).max(L.absenceDaysMax).optional(),
        }),
      )
      .min(1)
      .max(L.items),
  }),
  response: { 200: visitIds, 201: visitIds },
})

export const bookVisitsContract = defineContract({
  body: input({ visits: z.array(input({ id: id(), version: version() })).min(1).max(L.items), bookedOn: businessDate(), bookedPlace: words(L.bookedPlace).optional() }),
  response: { 200: visitIds },
})

const visitParams = input({ visitId: id() })
export const unbookVisitContract = defineContract({ params: visitParams, body: input({ version: version() }), response: { 200: visitIds } })
export const moveVisitContract = defineContract({ params: visitParams, body: input({ version: version(), dueOn: businessDate() }), response: { 200: visitIds } })
export const cancelVisitContract = defineContract({ params: visitParams, body: input({ version: version(), reason: z.enum(VISIT_CANCEL_REASONS) }), response: { 200: visitIds } })
export const doneVisitContract = defineContract({ params: visitParams, body: input({ version: version(), doneOn: businessDate() }), response: { 200: visitIds } })

export const visitOut = visitRowOut.extend({
  planId: id().nullable(),
  /** A return visit: the absence's length in days (more than 60); never its reason. */
  absenceDays: z.number().int().nullable(),
  booked: output({ on: businessDate(), place: z.string().nullable(), at: instant(), by: userRef.nullable() }).nullable(),
  cancelled: output({ at: instant(), by: userRef.nullable(), reason: z.enum(VISIT_CANCEL_REASONS) }).nullable(),
  /** The judgement recorded from it (open it to see it). */
  judgementId: id().nullable(),
  risks: z.array(z.string()),
})

export const openVisitContract = defineContract({ params: visitParams, response: { 200: output({ today: businessDate(), visit: visitOut, recorded: z.boolean(), law: z.string() }) } })

// ---- judgements ---------------------------------------------------------------------------------------------------------------

export const judgementRowOut = output({
  id: id(),
  companyId: id(),
  judgedOn: businessDate(),
  expiresOn: businessDate().nullable(),
  state: z.enum(JUDGEMENT_STATES),
  fromVisit: z.boolean(),
  hasCopy: z.boolean(),
  version: z.number().int(),
})

export const judgementListContract = defineContract({
  querystring: input({ ...scopeQuery, employeeId: id().optional(), state: z.enum([...JUDGEMENT_STATES, 'current', 'all']).optional(), offset: z.coerce.number().int().min(0).max(100_000).optional(), limit: z.coerce.number().int().min(1).max(L.list).optional() }),
  response: { 200: output({ today: businessDate(), judgements: z.array(judgementRowOut), more: z.boolean() }) },
})

const judgementValues = output({
  employee: person,
  outcome: z.enum(FITNESS_OUTCOMES),
  taskLimits: z.string().nullable(),
  unfitUntil: businessDate().nullable(),
})

export const showJudgementsContract = defineContract({
  body: input({ judgementIds: z.array(id()).min(1).max(L.show) }),
  response: { 200: output({ judgements: z.array(judgementRowOut.extend(judgementValues.shape)), recorded: z.boolean() }) },
})

export const judgementOut = judgementRowOut.extend({
  ...judgementValues.shape,
  visit: output({ id: id(), type: z.enum(VISIT_TYPES), doneOn: businessDate().nullable() }).nullable(),
  doctor: userRef.nullable(),
  voided: output({ at: instant(), by: userRef.nullable(), reason: z.enum(VOID_REASONS) }).nullable(),
  copies: z.array(output({ fileId: id(), name: z.string(), availableAt: instant().nullable() })),
  recordedAt: instant(),
})

const judgementParams = input({ judgementId: id() })
export const openJudgementContract = defineContract({ params: judgementParams, response: { 200: output({ today: businessDate(), judgement: judgementOut, recorded: z.boolean(), law: z.string(), hint: wordsIt }) } })

const judgementIds = output({ judgement: output({ id: id(), version: z.number().int() }), visit: output({ id: id(), version: z.number().int(), status: z.enum(VISIT_STATUSES) }).nullable(), replayed })

export const recordJudgementContract = defineContract({
  body: input({
    employeeId: id(),
    visitId: id().optional(),
    outcome: z.enum(FITNESS_OUTCOMES),
    taskLimits: z.string().max(L.taskLimits).optional(),
    unfitUntil: businessDate().optional(),
    judgedOn: businessDate(),
    expiresOn: businessDate().optional(),
    doctorAppointmentId: id().optional(),
  }),
  response: { 200: judgementIds, 201: judgementIds },
})

export const voidJudgementContract = defineContract({ params: judgementParams, body: input({ version: version(), reason: z.enum(VOID_REASONS) }), response: { 200: judgementIds } })

const announceIn = input({ originalName: words(500), contentType: z.string().trim().min(1).max(200), sizeBytes: z.number().int().min(1), sha256: z.string() })
export const announceCopyContract = defineContract({ params: judgementParams, body: announceIn, response: { 201: output({ file: fileView, upload: presignedView }) } })
export const completeCopyContract = defineContract({ params: input({ judgementId: id(), fileId: id() }), response: { 200: output({ file: fileView }) } })
export const openCopyContract = defineContract({ params: input({ judgementId: id(), fileId: id() }), response: { 200: output({ download: presignedView }) } })

// ---- who looked ---------------------------------------------------------------------------------------------------------------

export const viewsContract = defineContract({
  querystring: input({
    recordType: z.enum(['HEALTH_VISIT', 'FITNESS_JUDGEMENT']).optional(),
    recordId: id().optional(),
    employeeId: id().optional(),
    companyId: id().optional(),
    lists: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    limit: z.coerce.number().int().min(1).max(L.views).optional(),
  }),
  response: {
    200: output({
      views: z.array(output({ id: id(), viewer: userRef, viewedAt: instant(), recordType: z.enum(HEALTH_VIEW_RECORDS), recordId: id().nullable(), what: z.enum(VIEW_WHATS), employee: output({ id: id(), name: z.string() }).nullable() })),
      fitnessChecks: z.array(output({ viewer: userRef, at: instant() })),
      law: z.string(),
    }),
  },
})

// ---- fit yes or no --------------------------------------------------------------------------------------------------------------

export const fitnessContract = defineContract({
  params: input({ employeeId: id() }),
  response: { 200: output({ employeeId: id(), fit: z.boolean(), today: businessDate() }) },
})

// ---- the leaver's end-of-employment visit (../../people/leavers/visit-step.ts) --------------------------------------------------

const leaverStep = output({ id: id(), status: z.string(), version: z.number().int(), recordType: z.string().nullable(), recordId: id().nullable() })

export const exitVisitContract = defineContract({
  params: input({ caseId: id() }),
  response: {
    200: output({
      employee: output({ id: id(), name: z.string() }),
      step: leaverStep.nullable(),
      planAsks: z.boolean(),
      visits: z.array(output({ id: id(), dueOn: businessDate(), status: z.enum(VISIT_STATUSES), state: z.enum(VISIT_STATES), bookedOn: businessDate().nullable(), doneOn: businessDate().nullable(), version: z.number().int() })),
      recorded: z.boolean(),
    }),
  },
})

export const exitVisitStepContract = defineContract({
  params: input({ caseId: id(), stepId: id() }),
  body: input({ version: version(), visitId: id() }),
  response: { 200: output({ leaver: leaverOut }) },
})
