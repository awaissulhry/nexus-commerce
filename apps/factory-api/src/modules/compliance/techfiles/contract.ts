import { z } from 'zod'
import {
  ANNEX_III_POINTS,
  ASSESSMENT_STATUSES,
  BATCH_STATES,
  FREQUENCIES,
  HAZARDS,
  ITEM_STATES,
  MISSING_CODES,
  NOTE_MAX,
  PACK_CONTENTS,
  PACK_PURPOSES,
  PACK_SCOPES,
  PACK_STATUSES,
  PLAN_STATES,
  POINT_STATES,
  REASON_MAX,
  REASON_MIN,
  RESIDUAL_RISKS,
  RETENTION_STATES,
  TECHNICAL_FILE_STATUSES,
  TEST_KINDS,
  TEST_RESULTS,
} from '@nexus/factory-domain/compliance/techfiles/rules'
import { businessDate, defineContract, id, input, instant, output } from '@nexus/factory-domain/core/contracts'
import { presignedView } from '../../../platform/files/contract'
import { LIST_TILES } from './files'
import { REPORT_SOURCES } from './reports'
import { EVIDENCE_STATES } from './store'

/**
 * Technical files (B-W2b-251; PRD-296, PRD-299, PRD-301, PRD-302, QHS-048, QHS-110; design compliance.techfiles, SCR-120 — the
 * screens are B-W2b-269). Numbers, codes, days, states and counts; evidence by its label and whether it is still current;
 * people by name only where they reviewed, signed, kept or built a row. No cost, price or wage anywhere.
 */

const version = () => z.number().int().min(1)
const person = output({ id: id(), name: z.string() }).nullable()
const note = () => z.string().trim().min(1).max(NOTE_MAX)
const issue = output({ path: z.string(), message: z.string() })

// ---- technical files ------------------------------------------------------------------------------------------------------

const fileSummary = output({
  id: id(),
  number: z.string(),
  status: z.enum(TECHNICAL_FILE_STATUSES),
  companyId: id(),
  style: output({ id: id(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeClass: z.string().nullable() }),
  certificate: output({ id: id(), number: z.string(), standard: z.string(), status: z.string(), validTo: businessDate() }).nullable(),
  /** The certificates that cover the style: VALID ones and all. */
  certificates: output({ valid: z.number().int(), all: z.number().int() }),
  /** The grid's "9 of 13" bar. */
  annex: output({ done: z.number().int(), outOf: z.number().int(), open: z.enum(ANNEX_III_POINTS).nullable(), missingItems: z.number().int() }),
  risk: output({ id: id(), revision: z.number().int(), status: z.string(), signedAt: instant().nullable() }).nullable(),
  /** Recorded production-control tests of the style: how many, the newest test day. */
  testReports: output({ count: z.number().int(), latestOn: businessDate().nullable() }),
  /** Conformity to type: done batches, those with their evidence complete, missing, failed, still running. */
  production: output({ made: z.number().int(), withEvidence: z.number().int(), missing: z.number().int(), failed: z.number().int(), inProgress: z.number().int() }),
  /** The newest done batch (the row verb "Evidence trail of the latest batch": GET /quality/evidence?batch=). */
  latestBatch: output({ workOrderId: id(), number: z.string(), batchNumber: z.string().nullable() }).nullable(),
  keeper: person,
  lastChangeAt: instant(),
  retainUntil: businessDate().nullable(),
  retention: z.enum(RETENTION_STATES),
  may: output({ manage: z.boolean(), sign: z.boolean(), share: z.boolean() }),
  version: z.number().int(),
})

export const listFilesContract = defineContract({
  querystring: input({
    status: z.enum(TECHNICAL_FILE_STATUSES).optional(),
    q: z.string().trim().min(1).max(100).optional(),
    styleId: id().optional(),
    tile: z.enum(LIST_TILES).optional(),
  }),
  response: {
    200: output({
      files: z.array(fileSummary),
      tiles: output({
        complete: z.number().int(),
        withItemsMissing: z.number().int(),
        itemsMissing: z.number().int(),
        batchesWithoutEvidence: z.number().int(),
        retentionEndingInYear: z.number().int(),
        onLegalHold: z.number().int(),
        authorityPacksSentThisYear: z.number().int(),
      }),
      mayCreate: z.boolean(),
      asOf: instant(),
    }),
  },
})

const evidenceView = output({
  kind: z.enum(['RECORD', 'FILE']),
  recordType: z.string().nullable(),
  recordId: id().nullable(),
  fileId: id().nullable(),
  label: z.string(),
  state: z.enum(EVIDENCE_STATES),
  words: z.string().nullable(),
})

const itemView = output({
  id: id(),
  point: z.enum(ANNEX_III_POINTS),
  seq: z.number().int(),
  state: z.enum(ITEM_STATES),
  evidence: evidenceView.nullable(),
  note: z.string().nullable(),
  reviewedAt: instant().nullable(),
  reviewedBy: person,
  version: z.number().int(),
  updatedAt: instant(),
})

const fileRecord = output({
  file: fileSummary.extend({
    note: z.string().nullable(),
    completedAt: instant().nullable(),
    completedBy: person,
    archivedAt: instant().nullable(),
    archivedBy: person,
    archiveReason: z.string().nullable(),
    createdAt: instant(),
    createdBy: person,
  }),
  points: z.array(
    output({
      point: z.enum(ANNEX_III_POINTS),
      letter: z.string(),
      /** The design's LawRef: "Reg. (EU) 2016/425 Annex III (b)". */
      law: z.string(),
      title: output({ en: z.string(), it: z.string() }),
      state: z.enum(POINT_STATES),
      items: z.array(itemView),
    }),
  ),
  risk: output({ signed: output({ id: id(), revision: z.number().int(), signedAt: instant().nullable() }).nullable(), draft: output({ id: id(), revision: z.number().int() }).nullable() }),
  /** Why the file cannot be completed now (empty: it can, or it is not OPEN). */
  completeProblems: z.array(issue),
  asOf: instant(),
})

const fileParams = input({ fileId: id() })
const item = input({ fileId: id(), itemId: id() })

export const getFileContract = defineContract({ params: fileParams, response: { 200: fileRecord } })

export const createFileContract = defineContract({
  body: input({
    styleId: id(),
    /** Required for a style of every company: which company keeps the file. */
    companyId: id().optional(),
    certificateId: id().nullable().optional(),
    keeperId: id().nullable().optional(),
    note: note().nullable().optional(),
    /** Link the obvious evidence at once (default true). */
    suggest: z.boolean().optional(),
  }),
  response: { 200: fileRecord },
})

export const editFileContract = defineContract({
  params: fileParams,
  body: input({
    version: version(),
    certificateId: id().nullable().optional(),
    keeperId: id().nullable().optional(),
    note: note().nullable().optional(),
    /** ARCHIVED only: a later keep-until day. */
    retainUntil: businessDate().optional(),
  }),
  response: { 200: fileRecord },
})

export const completeFileContract = defineContract({ params: fileParams, body: input({ version: version() }), response: { 200: fileRecord } })
export const reopenFileContract = defineContract({ params: fileParams, body: input({ version: version(), reason: z.string().trim().min(REASON_MIN).max(REASON_MAX) }), response: { 200: fileRecord } })
export const archiveFileContract = defineContract({
  params: fileParams,
  body: input({ version: version(), reason: z.string().trim().min(REASON_MIN).max(REASON_MAX), retainUntil: businessDate().optional() }),
  response: { 200: fileRecord },
})

export const evidenceOptionsContract = defineContract({
  params: fileParams,
  querystring: input({ point: z.enum(ANNEX_III_POINTS).optional() }),
  response: {
    200: output({
      options: z.array(output({ kind: z.enum(['RECORD', 'FILE']), recordType: z.string(), recordId: id().nullable(), fileId: id().nullable(), label: z.string(), state: z.string(), points: z.array(z.enum(ANNEX_III_POINTS)), linked: z.boolean() })),
      point: z.enum(ANNEX_III_POINTS).nullable(),
    }),
  },
})

const evidenceBody = {
  recordType: z.string().trim().min(1).max(63).nullable().optional(),
  recordId: id().nullable().optional(),
  fileId: id().nullable().optional(),
}

export const addItemContract = defineContract({
  params: fileParams,
  body: input({ point: z.enum(ANNEX_III_POINTS), ...evidenceBody, note: note().nullable().optional() }),
  response: { 200: output({ record: fileRecord, itemId: id() }) },
})

export const editItemContract = defineContract({
  params: item,
  body: input({ version: version(), ...evidenceBody, note: note().nullable().optional(), state: z.enum(ITEM_STATES).optional() }),
  response: { 200: fileRecord },
})

export const removeItemContract = defineContract({ params: item, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: fileRecord } })

// ---- the risk assessment ---------------------------------------------------------------------------------------------------

const riskRowView = output({
  id: id(),
  seq: z.number().int(),
  hazard: z.enum(HAZARDS),
  hazardNote: z.string().nullable(),
  garmentZone: z.string().nullable(),
  intendedUse: z.string(),
  foreseeableMisuse: z.string().nullable(),
  control: z.string(),
  standardClause: z.string().nullable(),
  standardId: id().nullable(),
  residualRisk: z.enum(RESIDUAL_RISKS),
  note: z.string().nullable(),
  version: z.number().int(),
  updatedAt: instant(),
})

const riskAnswer = output({
  technicalFileId: id(),
  fileStatus: z.enum(TECHNICAL_FILE_STATUSES),
  assessments: z.array(
    output({
      id: id(),
      revision: z.number().int(),
      status: z.enum(ASSESSMENT_STATUSES),
      classReasoning: z.string().nullable(),
      note: z.string().nullable(),
      signedAt: instant().nullable(),
      signedBy: person,
      signedByName: z.string().nullable(),
      signedByFunction: z.string().nullable(),
      supersededAt: instant().nullable(),
      createdBy: person,
      rows: z.array(riskRowView),
      version: z.number().int(),
      createdAt: instant(),
      updatedAt: instant(),
    }),
  ),
  may: output({ manage: z.boolean(), sign: z.boolean() }),
  asOf: instant(),
})

const assessmentParams = input({ fileId: id(), assessmentId: id() })
const rowParams = input({ fileId: id(), assessmentId: id(), rowId: id() })
const reasoning = () => z.string().trim().min(1).max(8000)

export const getRiskContract = defineContract({ params: fileParams, response: { 200: riskAnswer } })
export const newRiskContract = defineContract({
  params: fileParams,
  body: input({ classReasoning: reasoning().nullable().optional(), note: note().nullable().optional(), copyRows: z.boolean().optional() }),
  response: { 200: riskAnswer },
})
export const editRiskContract = defineContract({
  params: assessmentParams,
  body: input({ version: version(), classReasoning: reasoning().nullable().optional(), note: note().nullable().optional() }),
  response: { 200: riskAnswer },
})
export const removeRiskContract = defineContract({ params: assessmentParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: riskAnswer } })

const rowFields = {
  hazard: z.enum(HAZARDS),
  hazardNote: z.string().trim().min(1).max(300).nullable().optional(),
  /** The zone code of the garment zone map ("shoulder", "knee-left"); null: the whole garment. */
  garmentZone: z.string().trim().min(1).max(40).nullable().optional(),
  intendedUse: z.string().trim().min(1).max(2000),
  foreseeableMisuse: z.string().trim().min(1).max(2000).nullable().optional(),
  control: z.string().trim().min(1).max(2000),
  standardClause: z.string().trim().min(1).max(100).nullable().optional(),
  standardId: id().nullable().optional(),
  residualRisk: z.enum(RESIDUAL_RISKS),
  note: note().nullable().optional(),
}

export const addRiskRowContract = defineContract({ params: assessmentParams, body: input(rowFields), response: { 200: riskAnswer } })
export const editRiskRowContract = defineContract({
  params: rowParams,
  body: input({ version: version(), ...rowFields, hazard: rowFields.hazard.optional(), intendedUse: rowFields.intendedUse.optional(), control: rowFields.control.optional(), residualRisk: rowFields.residualRisk.optional() }),
  response: { 200: riskAnswer },
})
export const removeRiskRowContract = defineContract({ params: rowParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: riskAnswer } })
export const signRiskContract = defineContract({
  params: assessmentParams,
  body: input({ version: version(), name: z.string().trim().min(1).max(200), function: z.string().trim().min(1).max(200) }),
  response: { 200: riskAnswer.extend({ reopened: z.boolean() }) },
})

// ---- test reports and production control --------------------------------------------------------------------------------

export const testReportsContract = defineContract({
  params: fileParams,
  response: {
    200: output({
      technicalFileId: id(),
      reports: z.array(
        output({
          source: z.enum(REPORT_SOURCES),
          id: id(),
          title: z.string(),
          reportNumber: z.string().nullable(),
          lab: z.string().nullable(),
          standardClause: z.string().nullable(),
          sample: z.string().nullable(),
          result: z.enum(TEST_RESULTS).nullable(),
          date: businessDate().nullable(),
          batchNumber: z.string().nullable(),
          file: output({ id: id(), name: z.string(), sha256: z.string() }).nullable(),
          certificate: output({ id: id(), number: z.string() }).nullable(),
        }),
      ),
      asOf: instant(),
    }),
  },
})

const testView = output({
  id: id(),
  companyId: id(),
  styleId: id(),
  workOrder: output({ id: id(), number: z.string() }).nullable(),
  batchNumber: z.string().nullable(),
  test: z.enum(TEST_KINDS),
  testName: z.string().nullable(),
  standardClause: z.string().nullable(),
  frequency: z.enum(FREQUENCIES),
  dueOn: businessDate(),
  sample: z.string().nullable(),
  result: z.enum(TEST_RESULTS).nullable(),
  testedOn: businessDate().nullable(),
  testedBy: z.string().nullable(),
  reportNumber: z.string().nullable(),
  resultNote: z.string().nullable(),
  labReportFile: output({ id: id(), name: z.string(), sha256: z.string() }).nullable(),
  retainUntil: businessDate().nullable(),
  retention: z.enum(RETENTION_STATES),
  overdue: z.boolean(),
  note: z.string().nullable(),
  version: z.number().int(),
  createdAt: instant(),
  updatedAt: instant(),
})

const planEntry = output({
  test: z.enum(TEST_KINDS),
  testName: z.string().nullable(),
  frequency: z.enum(FREQUENCIES),
  lastTestedOn: businessDate().nullable(),
  lastResult: z.enum(TEST_RESULTS).nullable(),
  nextDueOn: businessDate().nullable(),
  dueTestId: id().nullable(),
  state: z.enum(PLAN_STATES),
  tests: z.number().int(),
})

export const productionContract = defineContract({
  params: fileParams,
  querystring: input({ limit: z.coerce.number().int().min(1).max(500).optional() }),
  response: {
    200: output({
      technicalFileId: id(),
      styleId: id(),
      batches: z.array(
        output({
          workOrder: output({ id: id(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), siteId: id(), releasedAt: instant().nullable(), completedAt: instant().nullable() }),
          done: z.boolean(),
          inProcess: output({ decided: z.number().int(), failed: z.number().int(), open: z.number().int() }),
          tests: z.array(output({ id: id(), test: z.enum(TEST_KINDS), testName: z.string().nullable(), result: z.enum(TEST_RESULTS).nullable(), testedOn: businessDate().nullable(), dueOn: businessDate() })),
          finalInspection: output({ id: id(), number: z.string().nullable(), status: z.string(), decidedAt: instant().nullable() }).nullable(),
          releases: output({ count: z.number().int(), quantity: z.number().int(), lastAt: instant().nullable() }),
          evidence: output({
            state: z.enum(BATCH_STATES),
            missing: z.array(output({ code: z.enum(MISSING_CODES), test: z.enum(TEST_KINDS).nullable(), testName: z.string().nullable(), words: z.string() })),
            failed: z.array(z.string()),
          }),
        }),
      ),
      summary: output({ made: z.number().int(), withEvidence: z.number().int(), missing: z.number().int(), failed: z.number().int(), inProgress: z.number().int() }),
      plan: z.array(planEntry),
      tests: z.array(testView),
      asOf: instant(),
    }),
  },
})

export const listTestsContract = defineContract({
  querystring: input({ styleId: id().optional(), workOrderId: id().optional(), state: z.enum(['DUE', 'RECORDED', 'ALL']).optional() }),
  response: { 200: output({ tests: z.array(testView), asOf: instant() }) },
})

const recordFields = {
  result: z.enum(TEST_RESULTS),
  testedOn: businessDate(),
  testedBy: z.string().trim().min(1).max(200),
  reportNumber: z.string().trim().min(1).max(100).nullable().optional(),
  resultNote: z.string().trim().min(1).max(2000).nullable().optional(),
}

export const planTestContract = defineContract({
  body: input({
    styleId: id(),
    companyId: id().optional(),
    workOrderId: id().nullable().optional(),
    batchNumber: z.string().trim().min(1).max(60).nullable().optional(),
    test: z.enum(TEST_KINDS),
    testName: z.string().trim().min(1).max(200).nullable().optional(),
    standardClause: z.string().trim().min(1).max(100).nullable().optional(),
    frequency: z.enum(FREQUENCIES),
    dueOn: businessDate(),
    sample: z.string().trim().min(1).max(500).nullable().optional(),
    note: note().nullable().optional(),
    /** Recorded at once (a test done without being planned). */
    record: input(recordFields).optional(),
  }),
  response: { 200: output({ test: testView }) },
})

const testParams = input({ testId: id() })
export const recordTestContract = defineContract({
  params: testParams,
  body: input({ version: version(), ...recordFields, labReportFileId: id().nullable().optional() }),
  response: { 200: output({ test: testView }) },
})
export const editTestContract = defineContract({
  params: testParams,
  body: input({
    version: version(),
    dueOn: businessDate().optional(),
    sample: z.string().trim().min(1).max(500).nullable().optional(),
    standardClause: z.string().trim().min(1).max(100).nullable().optional(),
    testName: z.string().trim().min(1).max(200).nullable().optional(),
    note: note().nullable().optional(),
    retainUntil: businessDate().optional(),
  }),
  response: { 200: output({ test: testView }) },
})
export const removeTestContract = defineContract({ params: testParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ removed: id() }) } })

// ---- evidence packs ------------------------------------------------------------------------------------------------------

const fileRef = output({ id: id(), name: z.string(), sizeBytes: z.number().int(), sha256: z.string() })

const packView = output({
  id: id(),
  number: z.string(),
  companyId: id(),
  purpose: z.enum(PACK_PURPOSES),
  status: z.enum(PACK_STATUSES),
  technicalFileId: id().nullable(),
  scope: output({ kind: z.enum(PACK_SCOPES), batchNumbers: z.array(z.string()).nullable(), serialFrom: z.string().nullable(), serialTo: z.string().nullable(), shipmentId: id().nullable() }),
  include: z.array(z.enum(PACK_CONTENTS)),
  language: z.string(),
  recipient: z.string(),
  recipientParty: output({ id: id(), name: z.string() }).nullable(),
  /** BUILT: every document with its SHA-256 (sections of records and files). */
  contents: z.array(output({ title: z.string(), sha256: z.string(), recordType: z.string().nullable(), recordId: id().nullable(), fileId: id().nullable() })).nullable(),
  documents: z.number().int().nullable(),
  fingerprint: z.string().nullable(),
  pdf: fileRef.nullable(),
  zip: fileRef.nullable(),
  failureReason: z.string().nullable(),
  builtAt: instant().nullable(),
  builtBy: person,
  retainUntil: businessDate().nullable(),
  retention: z.enum(RETENTION_STATES),
  /** The DOCUMENT_VIEW links that carry its PDF and ZIP: expiry, state, opens and downloads (the design's "views"). */
  links: z.array(output({ id: id(), partyId: id(), email: z.string().nullable(), state: z.string(), expiresAt: instant(), password: z.boolean(), opens: z.number().int(), downloads: z.number().int(), revokedAt: instant().nullable(), createdAt: instant() })),
  note: z.string().nullable(),
  may: output({ share: z.boolean(), remove: z.boolean() }),
  version: z.number().int(),
  createdAt: instant(),
})

const packParams = input({ packId: id() })

export const listPacksContract = defineContract({
  params: fileParams,
  response: { 200: output({ technicalFileId: id(), packs: z.array(packView), contents: z.array(z.enum(PACK_CONTENTS)), asOf: instant() }) },
})

export const requestPackContract = defineContract({
  params: fileParams,
  body: input({
    purpose: z.enum(PACK_PURPOSES),
    language: z.string().trim().regex(/^[a-z]{2,3}$/),
    recipient: z.string().trim().min(1).max(300),
    recipientPartyId: id().nullable().optional(),
    scope: input({
      kind: z.enum(PACK_SCOPES),
      batchNumbers: z.array(z.string().trim().min(1).max(60)).max(100).optional(),
      serialFrom: z.string().trim().min(1).max(60).optional(),
      serialTo: z.string().trim().min(1).max(60).optional(),
      shipmentId: id().optional(),
    }),
    include: z.array(z.enum(PACK_CONTENTS)).min(1).max(PACK_CONTENTS.length).optional(),
    note: note().nullable().optional(),
  }),
  response: { 200: output({ pack: packView }) },
})

export const getPackContract = defineContract({ params: packParams, response: { 200: output({ pack: packView }) } })
export const downloadPackContract = defineContract({
  params: packParams,
  querystring: input({ file: z.enum(['PDF', 'ZIP']).optional() }),
  response: { 200: output({ download: presignedView, fileName: z.string() }) },
})
export const removePackContract = defineContract({ params: packParams, querystring: input({ version: z.coerce.number().int().min(1) }), response: { 200: output({ removed: id() }) } })

export const sharePackContract = defineContract({
  params: packParams,
  body: input({
    partyId: id().optional(),
    contactId: id().optional(),
    email: z.string().trim().min(3).max(320).optional(),
    password: z.string().min(1).max(200),
    expiresOn: businessDate(),
    maxUses: z.number().int().min(1).max(100).optional(),
    send: z.boolean().optional(),
    language: z.enum(['it', 'en']).optional(),
    message: z.string().trim().min(1).max(2000).optional(),
  }),
  response: { 200: output({ pack: packView, linkId: id(), url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() }) },
})

export const withdrawLinkContract = defineContract({
  params: input({ packId: id(), linkId: id() }),
  body: input({ reason: z.string().trim().min(3).max(500).optional() }),
  response: { 200: output({ pack: packView }) },
})
