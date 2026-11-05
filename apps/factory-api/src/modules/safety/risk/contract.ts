import { z } from 'zod'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { DOCUMENT_LANGUAGES } from '@nexus/factory-domain/documents/model'
import { money } from '@nexus/factory-domain/money/marked'
import { DVR_AUTHOR_KINDS, DVR_SIGN_METHODS, DVR_SIGNER_ROLES, DVR_VERSION_STATUSES, MEASURE_SOURCES, MEASURE_STATUSES, RISK_LIMITS } from '@nexus/factory-domain/safety/risk/rules'

/**
 * The risk assessment, the DVR (B-W2b-122; QHS-230, QHS-234; design plant.risk SCR-209: tiles, Assessments, Improvement plan
 * all sites, the record's Versions and Improvement plan tabs, the pop-ups New DVR version, Sign version and Add measure, the
 * new tab "DVR (frozen PDF)"). A version names its signers as the safety organisation does (the register's names, safety.view);
 * a measure's cost is the cost grain (money.cost: dropped from the answer without it, refused in a request without it).
 * Never a health value; never the floor.
 */

const version = () => z.number().int().min(1)
const words = (max: number) => z.string().trim().min(1).max(max)
const maybeWords = (max: number) => z.string().trim().max(max)
const codeName = output({ code: z.string(), name: z.string() })
const fileRef = output({ fileId: id(), name: z.string() })
const role = () => z.enum(DVR_SIGNER_ROLES)
const dueState = z.enum(['OVERDUE', 'DUE_SOON', 'PLANNED', 'DONE', 'CANCELLED'])

/** A version as a list row says it. */
const versionBrief = output({
  id: id(),
  versionNo: z.number().int(),
  label: z.string(),
  status: z.enum(DVR_VERSION_STATUSES),
  effectiveOn: z.string(),
  certainDateOn: z.string().nullable(),
  authorKind: z.enum(DVR_AUTHOR_KINDS),
  authorName: z.string(),
  /** Its signers, each signed or not (the column "signed by (employer, RSPP, RLS, doctor ✓)"). */
  signers: z.array(output({ role: role(), signedOn: z.string().nullable() })),
})

export const assessmentOut = output({
  id: id(),
  companyId: id(),
  company: codeName,
  siteId: id(),
  site: codeName,
  name: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  nextReviewOn: z.string().nullable(),
  reviewState: z.enum(['OVERDUE', 'DUE_SOON', 'PLANNED']).nullable(),
  note: z.string().nullable(),
  /** The newest SIGNED version (in force), and the version waiting for signatures, if any. */
  inForce: versionBrief.nullable(),
  waiting: versionBrief.nullable(),
  openMeasures: z.number().int(),
  overdueMeasures: z.number().int(),
  /** ACTIVE role sheets of the site. */
  roles: z.number().int(),
  version: z.number().int(),
  canManage: z.boolean(),
})

const signatureOut = output({
  id: id(),
  signerName: z.string(),
  signedOn: z.string(),
  signedAt: instant(),
  method: z.enum(DVR_SIGN_METHODS),
  appointmentId: id().nullable(),
  /** OFFICE: who signed in; PAPER: who recorded the paper; FLOOR_PIN: null (the worker signed with badge and PIN). */
  recordedBy: z.string().nullable(),
  /** PAPER: the signed paper's scan (the newest AVAILABLE file of the signature). */
  scan: fileRef.nullable(),
})

export const versionOut = output({
  id: id(),
  assessmentId: id(),
  versionNo: z.number().int(),
  label: z.string(),
  effectiveOn: z.string(),
  authorKind: z.enum(DVR_AUTHOR_KINDS),
  authorName: z.string(),
  changeSummary: z.string().nullable(),
  status: z.enum(DVR_VERSION_STATUSES),
  /** The newest SIGNED version; a SIGNED one below it is superseded (kept, never deleted). */
  inForce: z.boolean(),
  superseded: z.boolean(),
  /** The frozen PDF (a file of the assessment), its SHA-256 and when and by whom it was frozen: the DocumentSeal. */
  file: output({ fileId: id(), name: z.string(), sizeBytes: z.number().int(), contentType: z.string() }),
  sha256: z.string(),
  frozenAt: instant(),
  frozenBy: z.string().nullable(),
  certainDateOn: z.string().nullable(),
  signedAt: instant().nullable(),
  withdrawnAt: instant().nullable(),
  withdrawnReason: z.string().nullable(),
  signers: z.array(
    output({
      role: role(),
      /** The id this role's signature has, or will have: a paper's scan is uploaded as a file of it (record type RiskAssessmentSignature) first. */
      signatureId: id(),
      /** Who holds the role (the signature's appointment, or today's holder while unsigned). */
      holder: output({ appointmentId: id(), name: z.string() }).nullable(),
      signature: signatureOut.nullable(),
      /** The signed-in person may sign this role now, in the office (they hold it, hold safety.risk.sign, and signed no other role). */
      mine: z.boolean(),
    }),
  ),
  missing: z.array(role()),
  /** The kept seal (GeneratedDocument DVR_FROZEN, newest), once it is signed. */
  sealed: output({ documentId: id(), version: z.number().int(), language: z.string(), fileId: id(), createdAt: instant() }).nullable(),
  /** Measures of the improvement plan that came from this version. */
  measures: z.number().int(),
  version: z.number().int(),
})

const placeQuery = { companyId: id().optional(), siteId: id().optional() }

export const listAssessmentsContract = defineContract({
  querystring: input({ ...placeQuery, status: z.enum(['ACTIVE', 'ARCHIVED', 'all']).optional() }),
  response: { 200: output({ assessments: z.array(assessmentOut), canManage: z.boolean(), law: z.string(), today: z.string() }) },
})

export const countsContract = defineContract({
  querystring: input(placeQuery),
  response: {
    200: output({
      measuresOverdue: z.number().int(),
      measuresDueSoon: z.number().int(),
      reviewsDue: z.number().int(),
      rolesWithoutKitOrTraining: z.number().int(),
      signaturesMissing: z.number().int(),
      assessments: z.number().int(),
      /** Assessments with no signed version yet ("Add the current DVR"). */
      withoutVersion: z.number().int(),
      today: z.string(),
    }),
  },
})

const signerPlan = output({
  signers: z.array(output({ role: role(), appointmentId: id(), name: z.string() })),
  sameAs: z.array(output({ role: role(), as: role(), name: z.string() })),
  missingEmployer: z.boolean(),
})

export const assessmentRecordContract = defineContract({
  params: input({ assessmentId: id() }),
  response: {
    200: output({
      assessment: assessmentOut,
      versions: z.array(versionOut),
      /** Who would sign a version frozen today (the safety organisation in force). */
      next: signerPlan,
      plan: output({
        open: z.number().int(),
        overdue: z.number().int(),
        dueSoon: z.number().int(),
        done: z.number().int(),
        verified: z.number().int(),
        cancelled: z.number().int(),
        /** Open measures at the end of each week of the last year (the plan tab's burn-down). */
        burn: z.array(output({ on: z.string(), open: z.number().int() })),
      }),
      may: output({ manage: z.boolean(), sign: z.boolean(), upload: z.boolean() }),
      law: output({ dvr: z.string(), versions: z.string(), plan: z.string(), review: z.string() }),
      today: z.string(),
    }),
  },
})

export const createAssessmentContract = defineContract({
  body: input({
    companyId: id(),
    siteId: id(),
    /** The site or production unit it covers; unique on the site. */
    name: words(RISK_LIMITS.name),
    /** The next review, as the assessment or the consultant says (no interval is built in). */
    nextReviewOn: businessDate().nullish(),
    note: maybeWords(RISK_LIMITS.note).nullish(),
  }),
  response: { 201: output({ assessment: assessmentOut }), 200: output({ assessment: assessmentOut }) },
})

export const editAssessmentContract = defineContract({
  params: input({ assessmentId: id() }),
  body: input({ version: version(), name: words(RISK_LIMITS.name).optional(), nextReviewOn: businessDate().nullable().optional(), note: maybeWords(RISK_LIMITS.note).nullable().optional() }),
  response: { 200: output({ assessment: assessmentOut }) },
})

export const freezeVersionContract = defineContract({
  params: input({ assessmentId: id() }),
  body: input({
    /** The consultant's PDF, uploaded as a file of the assessment (the generic files routes, record type RiskAssessment) and AVAILABLE. */
    fileId: id(),
    label: z.string().trim().max(RISK_LIMITS.label),
    effectiveOn: businessDate(),
    authorKind: z.enum(DVR_AUTHOR_KINDS),
    authorName: z.string().trim().max(RISK_LIMITS.author),
    changeSummary: maybeWords(RISK_LIMITS.summary).nullish(),
  }),
  response: { 201: output({ version: versionOut }), 200: output({ version: versionOut }) },
})

export const withdrawVersionContract = defineContract({
  params: input({ versionId: id() }),
  body: input({ version: version(), reason: words(RISK_LIMITS.reason) }),
  response: { 200: output({ version: versionOut }) },
})

const signedAnswer = output({
  version: versionOut,
  /** Every signer signed: the version is SIGNED now, with its certain date. */
  complete: z.boolean(),
  /** The seal was kept in the same request (false: the file store did not answer; keep it with POST …/seal). */
  sealed: z.boolean(),
})

export const signVersionContract = defineContract({
  params: input({ versionId: id() }),
  body: input({
    role: role(),
    /** The signer types their own name (it must be the holder's, loosely). */
    signerName: words(RISK_LIMITS.signerName),
    /** The appointment held for the role (default: the one in force today at the site, or the whole company). */
    appointmentId: id().optional(),
  }),
  response: { 200: signedAnswer },
})

export const paperSignatureContract = defineContract({
  params: input({ versionId: id() }),
  body: input({
    role: role(),
    /** The name on the paper (the holder's, loosely). */
    signerName: words(RISK_LIMITS.signerName),
    /** The day written on the paper: from the day the version was frozen up to today. */
    signedOn: businessDate(),
    appointmentId: id().optional(),
  }),
  response: { 201: signedAnswer, 200: signedAnswer },
})

export const previewSealContract = defineContract({ params: input({ versionId: id() }), querystring: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }), response: {} })

export const keepSealContract = defineContract({
  params: input({ versionId: id() }),
  body: input({ language: z.enum(DOCUMENT_LANGUAGES).optional() }),
  response: {
    201: output({
      document: output({ id: id(), version: z.number().int(), language: z.string(), fileId: id(), createdAt: instant() }),
      /** False: the newest seal already showed exactly this. */
      made: z.boolean(),
      replayed: z.boolean(),
    }),
  },
})

export const measureOut = output({
  id: id(),
  assessmentId: id(),
  assessment: z.string(),
  companyId: id(),
  company: codeName,
  siteId: id(),
  site: codeName,
  title: z.string(),
  risk: z.string().nullable(),
  roleSheets: z.array(output({ id: id(), code: z.string(), name: z.string() })),
  ownerId: id().nullable(),
  owner: z.string().nullable(),
  mine: z.boolean(),
  dueOn: z.string().nullable(),
  dueState: dueState.nullable(),
  /** What it costs, minor units of `currency`: the cost grain only. */
  cost: money.cost(z.number().int().nullable()),
  currency: z.string(),
  status: z.enum(MEASURE_STATUSES),
  source: z.enum(MEASURE_SOURCES),
  sourceVersion: output({ id: id(), versionNo: z.number().int(), label: z.string() }).nullable(),
  sourceRecord: output({ type: z.string(), id: id() }).nullable(),
  doneAt: instant().nullable(),
  doneBy: z.string().nullable(),
  evidenceNote: z.string().nullable(),
  evidence: z.array(fileRef),
  verifiedAt: instant().nullable(),
  verifiedBy: z.string().nullable(),
  cancelledAt: instant().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number().int(),
  canManage: z.boolean(),
  /** The states the caller may move it to now (the owner: started, planned, done, back from done; a manager: every allowed move). */
  canMove: z.array(z.enum(MEASURE_STATUSES)),
})

export const listMeasuresContract = defineContract({
  querystring: input({
    ...placeQuery,
    assessmentId: id().optional(),
    /** open (default: planned and in progress), overdue, dueSoon (within 30 days), mine (open, owned by me), done (done and verified), cancelled, all. */
    view: z.enum(['open', 'overdue', 'dueSoon', 'mine', 'done', 'cancelled', 'all']).optional(),
    limit: z.coerce.number().int().min(1).max(RISK_LIMITS.list).optional(),
  }),
  response: { 200: output({ measures: z.array(measureOut), complete: z.boolean(), law: z.string(), today: z.string() }) },
})

export const measureRecordContract = defineContract({
  params: input({ measureId: id() }),
  response: { 200: output({ measure: measureOut, canUpload: z.boolean(), today: z.string() }) },
})

export const ownersContract = defineContract({
  querystring: input({ companyId: id() }),
  response: { 200: output({ owners: z.array(output({ id: id(), name: z.string(), me: z.boolean() })) }) },
})

export const createMeasureContract = defineContract({
  body: input({
    assessmentId: id(),
    title: z.string().trim().max(RISK_LIMITS.title),
    risk: maybeWords(RISK_LIMITS.risk).nullish(),
    roleSheetIds: z.array(id()).max(RISK_LIMITS.roleSheets).optional(),
    ownerId: id().nullish(),
    dueOn: businessDate().nullish(),
    /** Minor units of the company's currency, from 0. A cost: the grain wall refuses it without money.cost. */
    cost: money.cost(z.number().int().min(0).max(RISK_LIMITS.cost).nullable()),
    source: z.enum(MEASURE_SOURCES),
    /** DVR: the version it came from (default: the version in force, else the one waiting for signatures). */
    versionId: id().nullish(),
    sourceRecordType: z.string().trim().max(40).nullish(),
    sourceRecordId: id().nullish(),
    status: z.enum(['PLANNED', 'IN_PROGRESS']).optional(),
    note: maybeWords(RISK_LIMITS.note).nullish(),
  }),
  response: { 201: output({ measure: measureOut }), 200: output({ measure: measureOut }) },
})

export const editMeasureContract = defineContract({
  params: input({ measureId: id() }),
  body: input({
    version: version(),
    title: z.string().trim().max(RISK_LIMITS.title).optional(),
    risk: maybeWords(RISK_LIMITS.risk).nullable().optional(),
    roleSheetIds: z.array(id()).max(RISK_LIMITS.roleSheets).optional(),
    ownerId: id().nullable().optional(),
    dueOn: businessDate().nullable().optional(),
    cost: money.cost(z.number().int().min(0).max(RISK_LIMITS.cost).nullable()),
    note: maybeWords(RISK_LIMITS.note).nullable().optional(),
  }),
  response: { 200: output({ measure: measureOut }) },
})

export const moveMeasureContract = defineContract({
  params: input({ measureId: id() }),
  body: input({
    version: version(),
    status: z.enum(MEASURE_STATUSES),
    /** DONE: what was done (the evidence files are files of the measure, record type RiskMeasure). */
    evidenceNote: maybeWords(RISK_LIMITS.evidence).nullish(),
    /** CANCELLED: why. */
    reason: maybeWords(RISK_LIMITS.reason).nullish(),
  }),
  response: { 200: output({ measure: measureOut }) },
})
