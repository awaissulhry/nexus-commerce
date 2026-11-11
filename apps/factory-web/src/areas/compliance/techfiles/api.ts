import { z } from 'zod'
import {
  ANNEX_III_POINTS,
  ASSESSMENT_STATUSES,
  BATCH_STATES,
  FREQUENCIES,
  HAZARDS,
  ITEM_STATES,
  MISSING_CODES,
  PACK_CONTENTS,
  PACK_PURPOSES,
  PACK_SCOPES,
  PACK_STATUSES,
  PLAN_STATES,
  POINT_STATES,
  RESIDUAL_RISKS,
  RETENTION_STATES,
  TECHNICAL_FILE_STATUSES,
  TEST_KINDS,
  TEST_RESULTS,
  type AnnexIIIPoint,
  type Frequency,
  type Hazard,
  type ItemState,
  type PackContent,
  type PackPurpose,
  type PackScopeKind,
  type ResidualRisk,
  type TechnicalFileStatus,
  type TestKind,
  type TestResult,
} from '@nexus/factory-domain/compliance/techfiles/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, fileSchema, presignedSchema, requestUpload } from '../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Compliance › Technical files (SCR-120; B-W2b-269 on the API of B-W2b-251, apps/factory-api
 * modules/compliance/techfiles): the files and their tiles, one file with its Annex III points, the risk assessment, the test
 * reports, conformity to type per batch with the production-control tests, the evidence packs and their links, plus the files
 * uploaded onto a technical file (a drawing, through the generic files routes) or a test (its lab report, through the test's own
 * routes: B-W2b-278). Each answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped). Reading
 * is compliance.certificates.view; the writes
 * compliance.techfiles.manage; signing a risk assessment (techfiles.sign) and sending a pack by link (techfiles.share) need a
 * fresh code. The API's English is never shown as our words: the screens say their own from the codes. No money anywhere.
 */

const seg = (value: string) => encodeURIComponent(value)
const person = z.object({ id: z.string(), name: z.string() }).nullable()
const issue = z.object({ path: z.string(), message: z.string() })

/** The evidence states an item's record or file can be in (factory-api techfiles/store.ts EVIDENCE_STATES). */
export const EVIDENCE_STATES = ['CURRENT', 'DRAFT', 'SUPERSEDED', 'WITHDRAWN', 'EXPIRED', 'SUSPENDED', 'GONE'] as const
export type EvidenceState = (typeof EVIDENCE_STATES)[number]
/** Where a test report row comes from (factory-api techfiles/reports.ts REPORT_SOURCES). */
export const REPORT_SOURCES = ['CONTROL_TEST', 'CERTIFICATE_FILE', 'TECHFILE_ITEM'] as const
export type ReportSource = (typeof REPORT_SOURCES)[number]
/** The list's saved filters (factory-api techfiles/files.ts LIST_TILES). */
export const LIST_TILES = ['COMPLETE', 'ITEMS_MISSING', 'BATCHES_WITHOUT_EVIDENCE', 'RETENTION_ENDING', 'AUTHORITY_PACKS'] as const
export type ListTile = (typeof LIST_TILES)[number]

// ---- technical files -----------------------------------------------------------------------------------------------------

export const fileSummarySchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(TECHNICAL_FILE_STATUSES),
  companyId: z.string(),
  style: z.object({ id: z.string(), code: z.string(), name: z.string(), ppeCategory: z.string(), ppeClass: z.string().nullable() }),
  certificate: z.object({ id: z.string(), number: z.string(), standard: z.string(), status: z.string(), validTo: z.string() }).nullable(),
  certificates: z.object({ valid: z.number(), all: z.number() }),
  annex: z.object({ done: z.number(), outOf: z.number(), open: z.enum(ANNEX_III_POINTS).nullable(), missingItems: z.number() }),
  risk: z.object({ id: z.string(), revision: z.number(), status: z.string(), signedAt: z.string().nullable() }).nullable(),
  testReports: z.object({ count: z.number(), latestOn: z.string().nullable() }),
  production: z.object({ made: z.number(), withEvidence: z.number(), missing: z.number(), failed: z.number(), inProgress: z.number() }),
  latestBatch: z.object({ workOrderId: z.string(), number: z.string(), batchNumber: z.string().nullable() }).nullable(),
  keeper: person,
  lastChangeAt: z.string(),
  retainUntil: z.string().nullable(),
  retention: z.enum(RETENTION_STATES),
  may: z.object({ manage: z.boolean(), sign: z.boolean(), share: z.boolean() }),
  version: z.number(),
})
export type FileSummary = z.infer<typeof fileSummarySchema>

const tilesSchema = z.object({
  complete: z.number(),
  withItemsMissing: z.number(),
  itemsMissing: z.number(),
  batchesWithoutEvidence: z.number(),
  retentionEndingInYear: z.number(),
  onLegalHold: z.number(),
  authorityPacksSentThisYear: z.number(),
})
export type Tiles = z.infer<typeof tilesSchema>

const listAnswer = z.object({ files: z.array(fileSummarySchema), tiles: tilesSchema, mayCreate: z.boolean(), asOf: z.string() })
export type ListAnswer = z.infer<typeof listAnswer>

export const evidenceSchema = z.object({
  kind: z.enum(['RECORD', 'FILE']),
  recordType: z.string().nullable(),
  recordId: z.string().nullable(),
  fileId: z.string().nullable(),
  label: z.string(),
  state: z.enum(EVIDENCE_STATES),
  words: z.string().nullable(),
})
export type Evidence = z.infer<typeof evidenceSchema>

export const itemSchema = z.object({
  id: z.string(),
  point: z.enum(ANNEX_III_POINTS),
  seq: z.number(),
  state: z.enum(ITEM_STATES),
  evidence: evidenceSchema.nullable(),
  note: z.string().nullable(),
  reviewedAt: z.string().nullable(),
  reviewedBy: person,
  version: z.number(),
  updatedAt: z.string(),
})
export type Item = z.infer<typeof itemSchema>

export const pointSchema = z.object({
  point: z.enum(ANNEX_III_POINTS),
  letter: z.string(),
  law: z.string(),
  title: z.object({ en: z.string(), it: z.string() }),
  state: z.enum(POINT_STATES),
  items: z.array(itemSchema),
})
export type Point = z.infer<typeof pointSchema>

export const fileRecordSchema = z.object({
  file: fileSummarySchema.extend({
    note: z.string().nullable(),
    completedAt: z.string().nullable(),
    completedBy: person,
    archivedAt: z.string().nullable(),
    archivedBy: person,
    archiveReason: z.string().nullable(),
    createdAt: z.string(),
    createdBy: person,
  }),
  points: z.array(pointSchema),
  risk: z.object({ signed: z.object({ id: z.string(), revision: z.number(), signedAt: z.string().nullable() }).nullable(), draft: z.object({ id: z.string(), revision: z.number() }).nullable() }),
  completeProblems: z.array(issue),
  asOf: z.string(),
})
export type FileRecord = z.infer<typeof fileRecordSchema>
export type FileDetail = FileRecord['file']

export const optionSchema = z.object({
  kind: z.enum(['RECORD', 'FILE']),
  recordType: z.string(),
  recordId: z.string().nullable(),
  fileId: z.string().nullable(),
  label: z.string(),
  state: z.string(),
  points: z.array(z.enum(ANNEX_III_POINTS)),
  linked: z.boolean(),
})
export type EvidenceOption = z.infer<typeof optionSchema>
const optionsAnswer = z.object({ options: z.array(optionSchema), point: z.enum(ANNEX_III_POINTS).nullable() })

export interface ListQuery {
  readonly status: TechnicalFileStatus | null
  readonly q: string
  readonly tile: ListTile | null
  /** One style's files (New technical file: the live one a style already has). */
  readonly styleId?: string | null
}

/** GET /compliance/techfiles: the rows and the tiles (`?tile=` is a saved filter of the API's own). */
export const listFiles = (api: ApiClient, query: ListQuery, signal?: AbortSignal) =>
  api.get('/compliance/techfiles', {
    query: { ...(query.status ? { status: query.status } : {}), ...(query.q ? { q: query.q } : {}), ...(query.tile ? { tile: query.tile } : {}), ...(query.styleId ? { styleId: query.styleId } : {}) },
    schema: listAnswer,
    signal,
  })

/** GET /compliance/techfiles/:fileId: the file with its 13 Annex III points and why it cannot be completed now. */
export const readFile = (api: ApiClient, fileId: string, signal?: AbortSignal) => api.get(`/compliance/techfiles/${seg(fileId)}`, { schema: fileRecordSchema, signal })

export interface CreateFileBody {
  styleId: string
  companyId?: string
  certificateId?: string | null
  keeperId?: string | null
  note?: string | null
}

/** POST /compliance/techfiles: one live file per style (409 when one exists); the obvious evidence linked, nothing reviewed. */
export const createFile = (api: ApiClient, body: CreateFileBody, idempotencyKey: string) => api.post('/compliance/techfiles', { body: { ...body, suggest: true }, schema: fileRecordSchema, idempotencyKey })

/** PATCH /compliance/techfiles/:fileId: the certificate it supports (OPEN only), its keeper, its note; a later keep-until (ARCHIVED). */
export const editFile = (api: ApiClient, fileId: string, body: { version: number; certificateId?: string | null; keeperId?: string | null; note?: string | null; retainUntil?: string }, idempotencyKey: string) =>
  api.request('PATCH', `/compliance/techfiles/${seg(fileId)}`, { body, schema: fileRecordSchema, idempotencyKey })

export const completeFile = (api: ApiClient, fileId: string, version: number, idempotencyKey: string) => api.post(`/compliance/techfiles/${seg(fileId)}/complete`, { body: { version }, schema: fileRecordSchema, idempotencyKey })
export const reopenFile = (api: ApiClient, fileId: string, body: { version: number; reason: string }, idempotencyKey: string) => api.post(`/compliance/techfiles/${seg(fileId)}/reopen`, { body, schema: fileRecordSchema, idempotencyKey })
export const archiveFile = (api: ApiClient, fileId: string, body: { version: number; reason: string; retainUntil?: string }, idempotencyKey: string) =>
  api.post(`/compliance/techfiles/${seg(fileId)}/archive`, { body, schema: fileRecordSchema, idempotencyKey })

/** GET …/evidence-options?point=: the style's records and files that can prove a point (the point's first). */
export const evidenceOptions = (api: ApiClient, fileId: string, point: AnnexIIIPoint | null, signal?: AbortSignal) =>
  api.get(`/compliance/techfiles/${seg(fileId)}/evidence-options`, { query: point ? { point } : {}, schema: optionsAnswer, signal })

export interface EvidenceRef {
  recordType?: string | null
  recordId?: string | null
  fileId?: string | null
}

/** POST …/items: another row of a point (LINKED with evidence, else MISSING). */
export const addItem = (api: ApiClient, fileId: string, body: EvidenceRef & { point: AnnexIIIPoint; note?: string | null }, idempotencyKey: string) =>
  api.post(`/compliance/techfiles/${seg(fileId)}/items`, { body, schema: z.object({ record: fileRecordSchema, itemId: z.string() }), idempotencyKey })

/** PATCH …/items/:itemId: new evidence (→ LINKED), reviewed, not applicable (with a note), un-review, clear. */
export const editItem = (api: ApiClient, fileId: string, itemId: string, body: EvidenceRef & { version: number; note?: string | null; state?: ItemState }, idempotencyKey: string) =>
  api.request('PATCH', `/compliance/techfiles/${seg(fileId)}/items/${seg(itemId)}`, { body, schema: fileRecordSchema, idempotencyKey })

export const removeItem = (api: ApiClient, fileId: string, itemId: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `/compliance/techfiles/${seg(fileId)}/items/${seg(itemId)}`, { query: { version }, schema: fileRecordSchema, idempotencyKey })

// ---- the risk assessment ---------------------------------------------------------------------------------------------------

export const riskRowSchema = z.object({
  id: z.string(),
  seq: z.number(),
  hazard: z.enum(HAZARDS),
  hazardNote: z.string().nullable(),
  garmentZone: z.string().nullable(),
  intendedUse: z.string(),
  foreseeableMisuse: z.string().nullable(),
  control: z.string(),
  standardClause: z.string().nullable(),
  standardId: z.string().nullable(),
  residualRisk: z.enum(RESIDUAL_RISKS),
  note: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
})
export type RiskRow = z.infer<typeof riskRowSchema>

export const assessmentSchema = z.object({
  id: z.string(),
  revision: z.number(),
  status: z.enum(ASSESSMENT_STATUSES),
  classReasoning: z.string().nullable(),
  note: z.string().nullable(),
  signedAt: z.string().nullable(),
  signedBy: person,
  signedByName: z.string().nullable(),
  signedByFunction: z.string().nullable(),
  supersededAt: z.string().nullable(),
  createdBy: person,
  rows: z.array(riskRowSchema),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Assessment = z.infer<typeof assessmentSchema>

export const riskAnswerSchema = z.object({
  technicalFileId: z.string(),
  fileStatus: z.enum(TECHNICAL_FILE_STATUSES),
  assessments: z.array(assessmentSchema),
  may: z.object({ manage: z.boolean(), sign: z.boolean() }),
  asOf: z.string(),
})
export type RiskAnswer = z.infer<typeof riskAnswerSchema>

const riskBase = (fileId: string) => `/compliance/techfiles/${seg(fileId)}/risk`

export const readRisk = (api: ApiClient, fileId: string, signal?: AbortSignal) => api.get(riskBase(fileId), { schema: riskAnswerSchema, signal })
/** POST …/risk: the next revision, a DRAFT (one at a time), with the newest revision's rows copied. */
export const newRevision = (api: ApiClient, fileId: string, body: { classReasoning?: string | null; copyRows?: boolean }, idempotencyKey: string) => api.post(riskBase(fileId), { body, schema: riskAnswerSchema, idempotencyKey })
export const editRevision = (api: ApiClient, fileId: string, assessmentId: string, body: { version: number; classReasoning?: string | null; note?: string | null }, idempotencyKey: string) =>
  api.request('PATCH', `${riskBase(fileId)}/${seg(assessmentId)}`, { body, schema: riskAnswerSchema, idempotencyKey })
export const removeRevision = (api: ApiClient, fileId: string, assessmentId: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `${riskBase(fileId)}/${seg(assessmentId)}`, { query: { version }, schema: riskAnswerSchema, idempotencyKey })

export interface RiskRowBody {
  hazard: Hazard
  hazardNote?: string | null
  garmentZone?: string | null
  intendedUse: string
  foreseeableMisuse?: string | null
  control: string
  standardClause?: string | null
  residualRisk: ResidualRisk
  note?: string | null
}

export const addRiskRow = (api: ApiClient, fileId: string, assessmentId: string, body: RiskRowBody, idempotencyKey: string) =>
  api.post(`${riskBase(fileId)}/${seg(assessmentId)}/rows`, { body, schema: riskAnswerSchema, idempotencyKey })
/** PATCH a row (autosave per cell: the API merges the cell into the row and checks the row whole). */
export const editRiskRow = (api: ApiClient, fileId: string, assessmentId: string, rowId: string, body: Partial<RiskRowBody> & { version: number }, idempotencyKey: string) =>
  api.request('PATCH', `${riskBase(fileId)}/${seg(assessmentId)}/rows/${seg(rowId)}`, { body, schema: riskAnswerSchema, idempotencyKey })
export const removeRiskRow = (api: ApiClient, fileId: string, assessmentId: string, rowId: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `${riskBase(fileId)}/${seg(assessmentId)}/rows/${seg(rowId)}`, { query: { version }, schema: riskAnswerSchema, idempotencyKey })

/** POST …/sign (a fresh code: the caller's step-up guard asks for it on a 403 stepUp). `reopened`: a COMPLETE file went back to OPEN. */
export const signRevision = (api: ApiClient, fileId: string, assessmentId: string, body: { version: number; name: string; function: string }, idempotencyKey: string) =>
  api.post(`${riskBase(fileId)}/${seg(assessmentId)}/sign`, { body, schema: riskAnswerSchema.extend({ reopened: z.boolean() }), idempotencyKey })

// ---- test reports and production control --------------------------------------------------------------------------------

const fileRef = z.object({ id: z.string(), name: z.string(), sha256: z.string() })

export const reportSchema = z.object({
  source: z.enum(REPORT_SOURCES),
  id: z.string(),
  title: z.string(),
  reportNumber: z.string().nullable(),
  lab: z.string().nullable(),
  standardClause: z.string().nullable(),
  sample: z.string().nullable(),
  result: z.enum(TEST_RESULTS).nullable(),
  date: z.string().nullable(),
  batchNumber: z.string().nullable(),
  file: fileRef.nullable(),
  certificate: z.object({ id: z.string(), number: z.string() }).nullable(),
})
export type Report = z.infer<typeof reportSchema>
const reportsAnswer = z.object({ technicalFileId: z.string(), reports: z.array(reportSchema), asOf: z.string() })
export type ReportsAnswer = z.infer<typeof reportsAnswer>

export const readReports = (api: ApiClient, fileId: string, signal?: AbortSignal) => api.get(`/compliance/techfiles/${seg(fileId)}/test-reports`, { schema: reportsAnswer, signal })

export const testSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  styleId: z.string(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  batchNumber: z.string().nullable(),
  test: z.enum(TEST_KINDS),
  testName: z.string().nullable(),
  standardClause: z.string().nullable(),
  frequency: z.enum(FREQUENCIES),
  dueOn: z.string(),
  sample: z.string().nullable(),
  result: z.enum(TEST_RESULTS).nullable(),
  testedOn: z.string().nullable(),
  testedBy: z.string().nullable(),
  reportNumber: z.string().nullable(),
  resultNote: z.string().nullable(),
  labReportFile: fileRef.nullable(),
  retainUntil: z.string().nullable(),
  retention: z.enum(RETENTION_STATES),
  overdue: z.boolean(),
  note: z.string().nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type ControlTest = z.infer<typeof testSchema>

export const planEntrySchema = z.object({
  test: z.enum(TEST_KINDS),
  testName: z.string().nullable(),
  frequency: z.enum(FREQUENCIES),
  lastTestedOn: z.string().nullable(),
  lastResult: z.enum(TEST_RESULTS).nullable(),
  nextDueOn: z.string().nullable(),
  dueTestId: z.string().nullable(),
  state: z.enum(PLAN_STATES),
  tests: z.number(),
})
export type PlanEntry = z.infer<typeof planEntrySchema>

export const batchSchema = z.object({
  workOrder: z.object({ id: z.string(), number: z.string(), batchNumber: z.string().nullable(), status: z.string(), siteId: z.string(), releasedAt: z.string().nullable(), completedAt: z.string().nullable() }),
  done: z.boolean(),
  inProcess: z.object({ decided: z.number(), failed: z.number(), open: z.number() }),
  tests: z.array(z.object({ id: z.string(), test: z.enum(TEST_KINDS), testName: z.string().nullable(), result: z.enum(TEST_RESULTS).nullable(), testedOn: z.string().nullable(), dueOn: z.string() })),
  finalInspection: z.object({ id: z.string(), number: z.string().nullable(), status: z.string(), decidedAt: z.string().nullable() }).nullable(),
  releases: z.object({ count: z.number(), quantity: z.number(), lastAt: z.string().nullable() }),
  evidence: z.object({
    state: z.enum(BATCH_STATES),
    missing: z.array(z.object({ code: z.enum(MISSING_CODES), test: z.enum(TEST_KINDS).nullable(), testName: z.string().nullable(), words: z.string() })),
    failed: z.array(z.string()),
  }),
})
export type Batch = z.infer<typeof batchSchema>

export const productionSchema = z.object({
  technicalFileId: z.string(),
  styleId: z.string(),
  batches: z.array(batchSchema),
  summary: z.object({ made: z.number(), withEvidence: z.number(), missing: z.number(), failed: z.number(), inProgress: z.number() }),
  plan: z.array(planEntrySchema),
  tests: z.array(testSchema),
  asOf: z.string(),
})
export type Production = z.infer<typeof productionSchema>

export const readProduction = (api: ApiClient, fileId: string, signal?: AbortSignal) => api.get(`/compliance/techfiles/${seg(fileId)}/production`, { schema: productionSchema, signal })

export interface RecordFields {
  result: TestResult
  testedOn: string
  testedBy: string
  reportNumber?: string | null
  resultNote?: string | null
}

export interface PlanTestBody {
  styleId: string
  companyId?: string
  workOrderId?: string | null
  batchNumber?: string | null
  test: TestKind
  testName?: string | null
  standardClause?: string | null
  frequency: Frequency
  dueOn: string
  sample?: string | null
  note?: string | null
  record?: RecordFields
}

const testAnswer = z.object({ test: testSchema })

/** POST /compliance/production-tests: plan one (or record it at once). */
export const planTest = async (api: ApiClient, body: PlanTestBody, idempotencyKey: string) => (await api.post('/compliance/production-tests', { body, schema: testAnswer, idempotencyKey })).test
/** POST …/:testId/record: once; the lab report a file of THIS test, kept ten years with it. */
export const recordTest = async (api: ApiClient, testId: string, body: RecordFields & { version: number; labReportFileId?: string | null }, idempotencyKey: string) =>
  (await api.post(`/compliance/production-tests/${seg(testId)}/record`, { body, schema: testAnswer, idempotencyKey })).test
/** DELETE …/:testId: a planned test (a recorded one only once its keeping ended: 409 in words). */
export const removeTest = (api: ApiClient, testId: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `/compliance/production-tests/${seg(testId)}`, { query: { version }, schema: z.object({ removed: z.string() }), idempotencyKey })

// ---- evidence packs ------------------------------------------------------------------------------------------------------

const packFile = z.object({ id: z.string(), name: z.string(), sizeBytes: z.number(), sha256: z.string() })

export const linkSchema = z.object({
  id: z.string(),
  partyId: z.string(),
  email: z.string().nullable(),
  state: z.string(),
  expiresAt: z.string(),
  password: z.boolean(),
  opens: z.number(),
  downloads: z.number(),
  revokedAt: z.string().nullable(),
  createdAt: z.string(),
})
export type PackLink = z.infer<typeof linkSchema>

export const packSchema = z.object({
  id: z.string(),
  number: z.string(),
  companyId: z.string(),
  purpose: z.enum(PACK_PURPOSES),
  status: z.enum(PACK_STATUSES),
  technicalFileId: z.string().nullable(),
  scope: z.object({ kind: z.enum(PACK_SCOPES), batchNumbers: z.array(z.string()).nullable(), serialFrom: z.string().nullable(), serialTo: z.string().nullable(), shipmentId: z.string().nullable() }),
  include: z.array(z.enum(PACK_CONTENTS)),
  language: z.string(),
  recipient: z.string(),
  recipientParty: z.object({ id: z.string(), name: z.string() }).nullable(),
  contents: z.array(z.object({ title: z.string(), sha256: z.string(), recordType: z.string().nullable(), recordId: z.string().nullable(), fileId: z.string().nullable() })).nullable(),
  documents: z.number().nullable(),
  fingerprint: z.string().nullable(),
  pdf: packFile.nullable(),
  zip: packFile.nullable(),
  failureReason: z.string().nullable(),
  builtAt: z.string().nullable(),
  builtBy: person,
  retainUntil: z.string().nullable(),
  retention: z.enum(RETENTION_STATES),
  links: z.array(linkSchema),
  note: z.string().nullable(),
  may: z.object({ share: z.boolean(), remove: z.boolean() }),
  version: z.number(),
  createdAt: z.string(),
})
export type Pack = z.infer<typeof packSchema>

const packsAnswer = z.object({ technicalFileId: z.string(), packs: z.array(packSchema), contents: z.array(z.enum(PACK_CONTENTS)), asOf: z.string() })
export type PacksAnswer = z.infer<typeof packsAnswer>
const packAnswer = z.object({ pack: packSchema })

export const readPacks = (api: ApiClient, fileId: string, signal?: AbortSignal) => api.get(`/compliance/techfiles/${seg(fileId)}/packs`, { schema: packsAnswer, signal })
export const readPack = async (api: ApiClient, packId: string, signal?: AbortSignal) => (await api.get(`/compliance/evidence-packs/${seg(packId)}`, { schema: packAnswer, signal })).pack

export interface PackBody {
  purpose: PackPurpose
  language: string
  recipient: string
  recipientPartyId?: string | null
  scope: { kind: PackScopeKind; batchNumbers?: string[]; serialFrom?: string; serialTo?: string; shipmentId?: string }
  include: PackContent[]
  note?: string | null
}

/** POST …/packs: a BUILDING pack (the worker builds it; the page follows it by its live event or a read). */
export const requestPack = async (api: ApiClient, fileId: string, body: PackBody, idempotencyKey: string) => (await api.post(`/compliance/techfiles/${seg(fileId)}/packs`, { body, schema: packAnswer, idempotencyKey })).pack

export const removePack = (api: ApiClient, packId: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `/compliance/evidence-packs/${seg(packId)}`, { query: { version }, schema: z.object({ removed: z.string() }), idempotencyKey })

export interface ShareBody {
  partyId?: string
  email?: string
  password: string
  expiresOn: string
  send?: boolean
  language?: 'it' | 'en'
  message?: string
}

const shareAnswer = z.object({ pack: packSchema, linkId: z.string(), url: z.string().nullable(), delivery: z.enum(['SENT', 'FAILED', 'QUEUED']).nullable() })
export type ShareAnswer = z.infer<typeof shareAnswer>

/** POST …/link (a fresh code): a DOCUMENT_VIEW link of the PDF and the ZIP with a password and an end day. */
export const sharePack = (api: ApiClient, packId: string, body: ShareBody, idempotencyKey: string) => api.post(`/compliance/evidence-packs/${seg(packId)}/link`, { body, schema: shareAnswer, idempotencyKey })
export const withdrawLink = async (api: ApiClient, packId: string, linkId: string, reason: string | null, idempotencyKey: string) =>
  (await api.post(`/compliance/evidence-packs/${seg(packId)}/links/${seg(linkId)}/withdraw`, { body: reason ? { reason } : {}, schema: packAnswer, idempotencyKey })).pack

/**
 * The pack's PDF or ZIP as bytes (GET …/download answers a 60-second presigned GET; a plain link cannot send the company
 * header, so the page reads the bytes once).
 */
export async function packBytes(api: ApiClient, packId: string, file: 'PDF' | 'ZIP', signal?: AbortSignal): Promise<{ bytes: Uint8Array; fileName: string }> {
  const answer = await api.get(`/compliance/evidence-packs/${seg(packId)}/download`, { query: { file }, schema: z.object({ download: presignedSchema, fileName: z.string() }), signal })
  return { bytes: await readFromStore(answer.download), fileName: answer.fileName }
}

/** A stored file's bytes (a lab report, a drawing): GET /files/:id/download, then the store (files.read). */
export async function fileBytes(api: ApiClient, fileId: string, signal?: AbortSignal): Promise<Uint8Array> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }), signal })
  return readFromStore(answer.download)
}

// ---- people and parties, styles --------------------------------------------------------------------------------------------

const peopleAnswer = z.object({ people: z.array(z.object({ id: z.string(), name: z.string() })) })
export type PersonOption = z.infer<typeof peopleAnswer>['people'][number]

/** GET /tasks/assignees: who may keep the file (the people who can work on its record). */
export const readKeepers = async (api: ApiClient, fileId: string | null, signal?: AbortSignal) =>
  (await api.get('/tasks/assignees', { query: fileId ? { recordType: 'TechnicalFile', recordId: fileId } : {}, schema: peopleAnswer, signal })).people

const partiesAnswer = z.object({ parties: z.array(z.object({ id: z.string(), code: z.string(), legalName: z.string(), tradeName: z.string().nullable() })) })
export interface PartyOption {
  readonly id: string
  readonly name: string
  readonly code: string
}

/** GET /parties?q=: the recipient as a party (an authority or a customer must be one to get a link; parties.view). */
export const readParties = async (api: ApiClient, q: string, signal?: AbortSignal): Promise<PartyOption[]> =>
  (await api.get('/parties', { query: { ...(q ? { q } : {}), limit: 50 }, schema: partiesAnswer, signal })).parties.map((party) => ({ id: party.id, code: party.code, name: party.tradeName ?? party.legalName }))

const stylesAnswer = z.object({ styles: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), companyId: z.string().nullable(), ppeCategory: z.string() })) })
export type StyleOption = z.infer<typeof stylesAnswer>['styles'][number]

/** GET /product/styles?q=: the styles a new technical file can be for (the products area's own read). */
export const readStyles = async (api: ApiClient, q: string, signal?: AbortSignal) => (await api.get('/product/styles', { query: { ...(q ? { q } : {}), status: 'OPEN', limit: 50 }, schema: stylesAnswer, signal })).styles

const shipmentsAnswer = z.object({ shipments: z.array(z.object({ id: z.string(), number: z.string(), partyName: z.string(), status: z.string() })) })
export type ShipmentOption = z.infer<typeof shipmentsAnswer>['shipments'][number]

/** GET /shipping/shipments?q=: a shipment as a pack's scope (shipping.view). */
export const readShipments = async (api: ApiClient, q: string, signal?: AbortSignal) => (await api.get('/shipping/shipments', { query: { ...(q ? { q } : {}), limit: 50 }, schema: shipmentsAnswer, signal })).shipments

// ---- uploads ---------------------------------------------------------------------------------------------------------------

/** A drawing (point d / e) is any PDF, picture or office document; a lab report a PDF or a picture. */
export const DRAWING_TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'] as const
export const LAB_REPORT_TYPES = ['application/pdf', 'image/jpeg', 'image/png'] as const

/**
 * A file uploaded onto a record (announce, then the bytes to the store with the presigned request, then complete): a drawing onto
 * the technical file through the generic files routes (POST /files, kind ATTACHMENT), or a lab report onto its test through the
 * test's own routes (POST /compliance/production-tests/:testId/report, kind CERTIFICATE: a PDF or a photo of the paper; B-W2b-278:
 * the generic routes refuse a test's files). The answer is the file's id, linked next.
 */
export async function uploadOnto(api: ApiClient, input: { companyId: string; recordType: 'TechnicalFile' | 'ProductionControlTest'; recordId: string; file: File }): Promise<string> {
  const bytes = await input.file.arrayBuffer()
  const sha256 = await sha256Hex(bytes)
  if (input.recordType === 'ProductionControlTest') {
    const report = `/compliance/production-tests/${seg(input.recordId)}/report`
    const announced = await api.post(report, {
      body: { originalName: input.file.name, contentType: input.file.type || 'application/pdf', sizeBytes: input.file.size, sha256 },
      schema: z.object({ file: fileSchema, upload: presignedSchema }),
      idempotencyKey: newIdempotencyKey(),
    })
    await putToStore(announced.upload, bytes)
    await api.post(`${report}/${seg(announced.file.id)}/complete`, { body: {}, schema: z.object({ file: fileSchema }), idempotencyKey: newIdempotencyKey() })
    return announced.file.id
  }
  const announced = await requestUpload(api, {
    companyId: input.companyId,
    record: { type: input.recordType, id: input.recordId },
    kind: 'ATTACHMENT',
    name: input.file.name,
    contentType: input.file.type || 'application/pdf',
    sizeBytes: input.file.size,
    sha256,
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(presignedSchema.parse(announced.upload), bytes)
  await completeUpload(api, announced.file.id)
  return announced.file.id
}
