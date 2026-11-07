import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { completeUpload, downloadLink, presignedSchema, requestUpload } from '../../../record-panels/api'
import { putToStore, readFromStore, sha256Hex } from '../../../record-panels/store'
import { AUTHOR_KINDS, IMPACT_KINDS, ITEM_KINDS, MEASURE_SOURCES, MEASURE_STATUSES, SHEET_STATUSES, SIGNER_ROLES, SIGN_METHODS, VERSION_STATUSES } from './model'

/**
 * Every call of Plant › Health & safety › Risk assessment (SCR-209; B-W2b-144 on the API of B-W2b-122, apps/factory-api
 * modules/safety/risk, and B-W2b-128, modules/safety/rolesheets): the tiles, the assessments and one assessment with its
 * versions, signers, seal and plan; the measures and their moves; the role sheets, their pickers, "What this changes" and
 * Apply; the files of a version (the consultant's PDF, a paper signature's scan) through the generic files routes. Each
 * answer's shape is checked (zod mirrors of the API's contracts; unknown fields are dropped). The API's English is never
 * shown: the screens say their own words from the codes. A measure's cost reaches the page only with the cost grain.
 */

const seg = (value: string) => encodeURIComponent(value)
const codeName = z.object({ code: z.string(), name: z.string() })
const role = z.enum(SIGNER_ROLES)
const names = z.record(z.string(), z.string()).nullable()

// ---- assessments ------------------------------------------------------------------------------------------------------------

export const versionBriefSchema = z.object({
  id: z.string(),
  versionNo: z.number(),
  label: z.string(),
  status: z.enum(VERSION_STATUSES),
  effectiveOn: z.string(),
  certainDateOn: z.string().nullable(),
  authorKind: z.enum(AUTHOR_KINDS),
  authorName: z.string(),
  signers: z.array(z.object({ role, signedOn: z.string().nullable() })),
})
export type VersionBrief = z.infer<typeof versionBriefSchema>

export const assessmentSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string(),
  site: codeName,
  name: z.string(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  nextReviewOn: z.string().nullable(),
  reviewState: z.enum(['OVERDUE', 'DUE_SOON', 'PLANNED']).nullable(),
  note: z.string().nullable(),
  inForce: versionBriefSchema.nullable(),
  waiting: versionBriefSchema.nullable(),
  openMeasures: z.number(),
  overdueMeasures: z.number(),
  roles: z.number(),
  version: z.number(),
  canManage: z.boolean(),
})
export type Assessment = z.infer<typeof assessmentSchema>

const assessmentsAnswer = z.object({ assessments: z.array(assessmentSchema), canManage: z.boolean(), law: z.string(), today: z.string() })
export type AssessmentsAnswer = z.infer<typeof assessmentsAnswer>

const countsAnswer = z.object({
  measuresOverdue: z.number(),
  measuresDueSoon: z.number(),
  reviewsDue: z.number(),
  rolesWithoutKitOrTraining: z.number(),
  signaturesMissing: z.number(),
  assessments: z.number(),
  withoutVersion: z.number(),
  today: z.string(),
})
export type CountsAnswer = z.infer<typeof countsAnswer>

const fileRef = z.object({ fileId: z.string(), name: z.string() })

export const signerSchema = z.object({
  role,
  signatureId: z.string(),
  holder: z.object({ appointmentId: z.string(), name: z.string() }).nullable(),
  signature: z
    .object({
      id: z.string(),
      signerName: z.string(),
      signedOn: z.string(),
      signedAt: z.string(),
      method: z.enum(SIGN_METHODS),
      appointmentId: z.string().nullable(),
      recordedBy: z.string().nullable(),
      scan: fileRef.nullable(),
    })
    .nullable(),
  mine: z.boolean(),
})
export type Signer = z.infer<typeof signerSchema>

export const versionSchema = z.object({
  id: z.string(),
  assessmentId: z.string(),
  versionNo: z.number(),
  label: z.string(),
  effectiveOn: z.string(),
  authorKind: z.enum(AUTHOR_KINDS),
  authorName: z.string(),
  changeSummary: z.string().nullable(),
  status: z.enum(VERSION_STATUSES),
  inForce: z.boolean(),
  superseded: z.boolean(),
  file: z.object({ fileId: z.string(), name: z.string(), sizeBytes: z.number(), contentType: z.string() }),
  sha256: z.string(),
  frozenAt: z.string(),
  frozenBy: z.string().nullable(),
  certainDateOn: z.string().nullable(),
  signedAt: z.string().nullable(),
  withdrawnAt: z.string().nullable(),
  withdrawnReason: z.string().nullable(),
  signers: z.array(signerSchema),
  missing: z.array(role),
  sealed: z.object({ documentId: z.string(), version: z.number(), language: z.string(), fileId: z.string(), createdAt: z.string() }).nullable(),
  measures: z.number(),
  version: z.number(),
})
export type DvrVersion = z.infer<typeof versionSchema>

export const signerPlanSchema = z.object({
  signers: z.array(z.object({ role, appointmentId: z.string(), name: z.string() })),
  sameAs: z.array(z.object({ role, as: role, name: z.string() })),
  missingEmployer: z.boolean(),
})
export type SignerPlan = z.infer<typeof signerPlanSchema>

const planSchema = z.object({
  open: z.number(),
  overdue: z.number(),
  dueSoon: z.number(),
  done: z.number(),
  verified: z.number(),
  cancelled: z.number(),
  burn: z.array(z.object({ on: z.string(), open: z.number() })),
})
export type PlanFigures = z.infer<typeof planSchema>

export const recordSchema = z.object({
  assessment: assessmentSchema,
  versions: z.array(versionSchema),
  next: signerPlanSchema,
  plan: planSchema,
  may: z.object({ manage: z.boolean(), sign: z.boolean(), upload: z.boolean() }),
  law: z.object({ dvr: z.string(), versions: z.string(), plan: z.string(), review: z.string() }),
  today: z.string(),
})
export type AssessmentRecord = z.infer<typeof recordSchema>

// ---- measures ---------------------------------------------------------------------------------------------------------------

export const measureSchema = z.object({
  id: z.string(),
  assessmentId: z.string(),
  assessment: z.string(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string(),
  site: codeName,
  title: z.string(),
  risk: z.string().nullable(),
  roleSheets: z.array(z.object({ id: z.string(), code: z.string(), name: z.string() })),
  ownerId: z.string().nullable(),
  owner: z.string().nullable(),
  mine: z.boolean(),
  dueOn: z.string().nullable(),
  dueState: z.enum(['OVERDUE', 'DUE_SOON', 'PLANNED', 'DONE', 'CANCELLED']).nullable(),
  /** Minor units of `currency`: present only with the cost grain (the API drops the key otherwise). */
  cost: z.number().nullable().optional(),
  currency: z.string(),
  status: z.enum(MEASURE_STATUSES),
  source: z.enum(MEASURE_SOURCES),
  sourceVersion: z.object({ id: z.string(), versionNo: z.number(), label: z.string() }).nullable(),
  sourceRecord: z.object({ type: z.string(), id: z.string() }).nullable(),
  doneAt: z.string().nullable(),
  doneBy: z.string().nullable(),
  evidenceNote: z.string().nullable(),
  evidence: z.array(fileRef),
  verifiedAt: z.string().nullable(),
  verifiedBy: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
  version: z.number(),
  canManage: z.boolean(),
  canMove: z.array(z.enum(MEASURE_STATUSES)),
})
export type Measure = z.infer<typeof measureSchema>

const measuresAnswer = z.object({ measures: z.array(measureSchema), complete: z.boolean(), law: z.string(), today: z.string() })
export type MeasuresAnswer = z.infer<typeof measuresAnswer>
export type MeasureView = 'open' | 'overdue' | 'dueSoon' | 'mine' | 'done' | 'cancelled' | 'all'

const ownerSchema = z.object({ id: z.string(), name: z.string(), me: z.boolean() })
export type Owner = z.infer<typeof ownerSchema>

// ---- role sheets ------------------------------------------------------------------------------------------------------------

export const sheetRowSchema = z.object({
  id: z.string(),
  companyId: z.string(),
  company: codeName,
  siteId: z.string(),
  site: codeName,
  code: z.string(),
  name: z.string(),
  nameI18n: names,
  status: z.enum(SHEET_STATUSES),
  people: z.number(),
  risks: z.number(),
  surveillanceNeeds: z.number(),
  ppeItems: z.number(),
  courses: z.number(),
  surveillance: z.object({ needed: z.boolean().nullable(), frequencyMonths: z.number().nullable() }),
  updatedAt: z.string(),
  version: z.number(),
  canManage: z.boolean(),
})
export type SheetRow = z.infer<typeof sheetRowSchema>

export const sheetSchema = sheetRowSchema.extend({
  description: z.string().nullable(),
  createdAt: z.string(),
  items: z.array(z.object({ id: z.string(), seq: z.number(), kind: z.enum(ITEM_KINDS), title: z.string(), note: z.string().nullable() })),
  kit: z.array(
    z.object({
      id: z.string(),
      seq: z.number(),
      ppeItemId: z.string(),
      item: z.object({ code: z.string(), name: z.string(), nameI18n: names, category: z.string(), standard: z.string().nullable(), sizes: z.array(z.string()), status: z.enum(SHEET_STATUSES) }),
      quantity: z.number(),
      whenToWear: z.string(),
      note: z.string().nullable(),
    }),
  ),
  requirements: z.array(
    z.object({
      id: z.string(),
      courseId: z.string(),
      course: z.object({ code: z.string(), name: z.string(), nameI18n: names, type: z.string(), hours: z.string(), refresherMonths: z.number().nullable(), status: z.enum(SHEET_STATUSES) }),
      withinDays: z.number().nullable(),
      note: z.string().nullable(),
    }),
  ),
  plan: z.object({ needed: z.boolean().nullable(), frequencyMonths: z.number().nullable(), endOfEmploymentVisit: z.boolean(), setOn: z.string().nullable() }),
  peopleInRole: z.array(z.object({ employeeId: z.string(), name: z.string() })),
})
export type RoleSheet = z.infer<typeof sheetSchema>

const sheetLaw = z.object({ roleSheet: z.string(), kit: z.string(), training: z.string(), surveillance: z.string(), yearlyVisit: z.string() })
export type SheetLaw = z.infer<typeof sheetLaw>

const sheetsAnswer = z.object({ roleSheets: z.array(sheetRowSchema), complete: z.boolean(), canAdd: z.boolean(), law: sheetLaw, today: z.string() })
export type SheetsAnswer = z.infer<typeof sheetsAnswer>

const sheetAnswer = z.object({ roleSheet: sheetSchema, law: sheetLaw, today: z.string() })
export type SheetAnswer = z.infer<typeof sheetAnswer>

const catalogueAnswer = z.object({
  ppeItems: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, category: z.string(), standard: z.string().nullable(), sizes: z.array(z.string()) })),
  courses: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, type: z.string(), hours: z.string(), refresherMonths: z.number().nullable() })),
})
export type Catalogue = z.infer<typeof catalogueAnswer>

const changesSchema = z.object({
  header: z.array(z.string()),
  risks: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  surveillanceNeeds: z.object({ added: z.array(z.string()), removed: z.array(z.string()) }),
  kit: z.object({
    added: z.array(z.string()),
    removed: z.array(z.string()),
    changed: z.array(z.object({ ppeItemId: z.string(), quantity: z.object({ from: z.number(), to: z.number() }).nullable(), whenToWear: z.object({ from: z.string(), to: z.string() }).nullable() })),
  }),
  courses: z.object({ added: z.array(z.string()), removed: z.array(z.string()), changed: z.array(z.object({ courseId: z.string(), withinDays: z.object({ from: z.number().nullable(), to: z.number().nullable() }) })) }),
  surveillance: z.object({ from: z.boolean().nullable(), to: z.boolean() }).nullable(),
  nothing: z.boolean(),
})
export type SheetChanges = z.infer<typeof changesSchema>

export const impactLineSchema = z.object({
  kind: z.enum(IMPACT_KINDS),
  courseId: z.string().nullable(),
  ppeItemId: z.string().nullable(),
  people: z.number(),
  already: z.number(),
  names: z.array(z.object({ employeeId: z.string(), name: z.string() })).nullable(),
  withinDays: z.object({ from: z.number().nullable(), to: z.number().nullable() }).nullable(),
  quantity: z.number().nullable(),
  frequencyMonths: z.number().nullable(),
})
export type ImpactLine = z.infer<typeof impactLineSchema>

const refsSchema = z.object({
  courses: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, type: z.string() })),
  ppeItems: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), nameI18n: names, category: z.string() })),
})
export type ImpactRefs = z.infer<typeof refsSchema>

const previewAnswer = z.object({ changes: changesSchema, impact: z.array(impactLineSchema), people: z.number(), refs: refsSchema, fingerprint: z.string(), today: z.string() })
export type SheetPreview = z.infer<typeof previewAnswer>
const applyAnswer = z.object({ roleSheet: sheetSchema, changes: changesSchema, impact: z.array(impactLineSchema), people: z.number(), refs: refsSchema, fingerprint: z.string(), applied: z.boolean() })
export type SheetApplied = z.infer<typeof applyAnswer>

// ---- reads ------------------------------------------------------------------------------------------------------------------

const place = (siteId: string | null | undefined) => (siteId ? { siteId } : {})

/** GET /safety/risk/counts (safety.view): the tiles of the top bar's site. */
export const readCounts = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/risk/counts', { query: place(siteId), schema: countsAnswer, signal })

/** GET /safety/risk/assessments (safety.view): one row per site or production unit (ACTIVE). */
export const listAssessments = (api: ApiClient, siteId: string | null, signal?: AbortSignal) => api.get('/safety/risk/assessments', { query: place(siteId), schema: assessmentsAnswer, signal })

/** GET /safety/risk/assessments/:id (safety.view): the assessment, every version, who signs next, the plan's figures, what the caller may do. */
export const readAssessment = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/risk/assessments/${seg(id)}`, { schema: recordSchema, signal })

export interface MeasureQuery {
  readonly siteId?: string | null
  readonly assessmentId?: string | null
  readonly view?: MeasureView
}

/** GET /safety/risk/measures (safety.view): by due day (no day last); the cost key only with the cost grain. */
export const listMeasures = (api: ApiClient, query: MeasureQuery, signal?: AbortSignal) =>
  api.get('/safety/risk/measures', {
    query: { ...place(query.siteId), ...(query.assessmentId ? { assessmentId: query.assessmentId } : {}), ...(query.view && query.view !== 'open' ? { view: query.view } : {}), limit: 500 },
    schema: measuresAnswer,
    signal,
  })

/** GET /safety/risk/measures/:id (safety.view): one measure, its evidence files, whether the caller may upload. */
export const readMeasure = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/risk/measures/${seg(id)}`, { schema: z.object({ measure: measureSchema, canUpload: z.boolean(), today: z.string() }), signal })

/** GET /safety/risk/owners?companyId (safety.risk.manage): who may own a measure. */
export const readOwners = async (api: ApiClient, companyId: string, signal?: AbortSignal) => (await api.get('/safety/risk/owners', { query: { companyId }, schema: z.object({ owners: z.array(ownerSchema) }), signal })).owners

/** GET /safety/rolesheets (safety.view): the index. */
export const listSheets = (api: ApiClient, query: { siteId?: string | null; q?: string | null; status?: 'ACTIVE' | 'ARCHIVED' | 'all' }, signal?: AbortSignal) =>
  api.get('/safety/rolesheets', { query: { ...place(query.siteId), ...(query.q ? { q: query.q } : {}), ...(query.status && query.status !== 'ACTIVE' ? { status: query.status } : {}) }, schema: sheetsAnswer, signal })

/** GET /safety/rolesheets/:id (safety.view): one sheet with its people. */
export const readSheet = (api: ApiClient, id: string, signal?: AbortSignal) => api.get(`/safety/rolesheets/${seg(id)}`, { schema: sheetAnswer, signal })

/** GET /safety/rolesheets/catalogue?companyId (safety.rolesheets.manage): the PPE items and courses to pick from. */
export const readCatalogue = (api: ApiClient, companyId: string, signal?: AbortSignal) => api.get('/safety/rolesheets/catalogue', { query: { companyId }, schema: catalogueAnswer, signal })

/** GET /safety/risk/versions/:id/seal?language= (safety.view): the seal as a PDF (a preview banner while signatures wait). */
export const sealPreview = (api: ApiClient, versionId: string, language: 'it' | 'en', signal?: AbortSignal) => api.bytes(`/safety/risk/versions/${seg(versionId)}/seal`, { query: { language }, signal })

/** GET /files/:id/download (files.read): a file's bytes, read once (the address lives 60 seconds). */
export async function fileBytes(api: ApiClient, fileId: string): Promise<Uint8Array> {
  const { download } = await downloadLink(api, fileId)
  return readFromStore(download)
}

/** A file's address to open in a new tab (a presigned GET of 60 seconds; a same-origin path goes through this app's /api). */
export async function fileAddress(api: ApiClient, fileId: string): Promise<string> {
  const { download } = await downloadLink(api, fileId)
  return download.url.startsWith('/') && !download.url.startsWith('//') ? `/api${download.url}` : download.url
}

// ---- writes -----------------------------------------------------------------------------------------------------------------

const assessmentAnswer = z.object({ assessment: assessmentSchema })
const versionAnswer = z.object({ version: versionSchema })
const signedAnswer = z.object({ version: versionSchema, complete: z.boolean(), sealed: z.boolean() })
export type SignedAnswer = z.infer<typeof signedAnswer>
const measureAnswer = z.object({ measure: measureSchema })
const keptSeal = z.object({ document: z.object({ id: z.string(), version: z.number(), language: z.string(), fileId: z.string(), createdAt: z.string() }), made: z.boolean(), replayed: z.boolean() })
export type KeptSeal = z.infer<typeof keptSeal>

/** POST /safety/risk/assessments (safety.risk.manage): "Add the current DVR" starts here, one per site or unit. */
export const addAssessment = async (api: ApiClient, body: { companyId: string; siteId: string; name: string; nextReviewOn: string | null; note: string | null }, idempotencyKey: string) =>
  (await api.post('/safety/risk/assessments', { body, schema: assessmentAnswer, idempotencyKey })).assessment

/** PATCH /safety/risk/assessments/:id (safety.risk.manage): the name, the next review, the note. */
export const editAssessment = async (api: ApiClient, id: string, body: { version: number; name?: string; nextReviewOn?: string | null; note?: string | null }, idempotencyKey: string) =>
  (await api.request('PATCH', `/safety/risk/assessments/${seg(id)}`, { body, schema: assessmentAnswer, idempotencyKey })).assessment

export interface FreezeBody {
  fileId: string
  label: string
  effectiveOn: string
  authorKind: (typeof AUTHOR_KINDS)[number]
  authorName: string
  changeSummary: string | null
}

/** POST /safety/risk/assessments/:id/versions (safety.risk.manage): freeze the uploaded PDF as the next version, waiting for its signers. */
export const freezeVersion = async (api: ApiClient, assessmentId: string, body: FreezeBody, idempotencyKey: string) =>
  (await api.post(`/safety/risk/assessments/${seg(assessmentId)}/versions`, { body, schema: versionAnswer, idempotencyKey })).version

/** POST /safety/risk/versions/:id/withdraw (safety.risk.manage): only while it waits. */
export const withdrawVersion = async (api: ApiClient, versionId: string, body: { version: number; reason: string }, idempotencyKey: string) =>
  (await api.post(`/safety/risk/versions/${seg(versionId)}/withdraw`, { body, schema: versionAnswer, idempotencyKey })).version

/** POST /safety/risk/versions/:id/sign (safety.risk.sign): the holder signs in the office; 403 `stepUp` asks a fresh code after every other check. */
export const signVersion = (api: ApiClient, versionId: string, body: { role: string; signerName: string }, idempotencyKey: string) => api.post(`/safety/risk/versions/${seg(versionId)}/sign`, { body, schema: signedAnswer, idempotencyKey })

/** POST /safety/risk/versions/:id/signatures (safety.risk.manage): a signed paper, its scan already on file. */
export const paperSignature = (api: ApiClient, versionId: string, body: { role: string; signerName: string; signedOn: string }, idempotencyKey: string) =>
  api.post(`/safety/risk/versions/${seg(versionId)}/signatures`, { body, schema: signedAnswer, idempotencyKey })

/** POST /safety/risk/versions/:id/seal (safety.risk.manage): keep the seal (SIGNED only; the same contents give the same one back). */
export const keepSeal = (api: ApiClient, versionId: string, language: 'it' | 'en', idempotencyKey: string) => api.post(`/safety/risk/versions/${seg(versionId)}/seal`, { body: { language }, schema: keptSeal, idempotencyKey })

export interface MeasureBody {
  title: string
  risk: string | null
  roleSheetIds: string[]
  ownerId: string | null
  dueOn: string | null
  /** Sent only with the cost grain (the API refuses the field without it). */
  cost?: number | null
  note: string | null
}

/** POST /safety/risk/measures (safety.risk.manage). */
export const addMeasure = async (api: ApiClient, body: MeasureBody & { assessmentId: string; source: string; versionId?: string | null; status?: 'PLANNED' | 'IN_PROGRESS' }, idempotencyKey: string) =>
  (await api.post('/safety/risk/measures', { body, schema: measureAnswer, idempotencyKey })).measure

/** PATCH /safety/risk/measures/:id (safety.risk.manage): the fields sent change; the version read guards it. */
export const editMeasure = async (api: ApiClient, id: string, body: Partial<MeasureBody> & { version: number }, idempotencyKey: string) =>
  (await api.request('PATCH', `/safety/risk/measures/${seg(id)}`, { body, schema: measureAnswer, idempotencyKey })).measure

/** POST /safety/risk/measures/:id/status (safety.view: its owner's moves; a manager also verifies and cancels). */
export const moveMeasure = async (api: ApiClient, id: string, body: { version: number; status: string; evidenceNote?: string | null; reason?: string | null }, idempotencyKey: string) =>
  (await api.post(`/safety/risk/measures/${seg(id)}/status`, { body, schema: measureAnswer, idempotencyKey })).measure

export interface SheetDraftBody {
  name?: string
  description?: string | null
  content: { items: { kind: string; title: string; note: string | null }[]; kit: { ppeItemId: string; quantity: number; whenToWear: string; note: string | null }[]; requirements: { courseId: string; withinDays: number | null; note: string | null }[] }
  surveillance?: { needed: boolean }
}

/** POST /safety/rolesheets (safety.rolesheets.manage): "Add the first role". */
export const addSheet = async (api: ApiClient, body: { companyId: string; siteId: string; code: string; name: string; description: string | null }, idempotencyKey: string) =>
  (await api.post('/safety/rolesheets', { body, schema: z.object({ roleSheet: sheetSchema }), idempotencyKey })).roleSheet

/** POST /safety/rolesheets/:id/preview (safety.rolesheets.manage): "What this changes" for the whole draft. Nothing is written. */
export const previewSheet = (api: ApiClient, id: string, body: SheetDraftBody, signal?: AbortSignal) => api.post(`/safety/rolesheets/${seg(id)}/preview`, { body, schema: previewAnswer, signal })

/** POST /safety/rolesheets/:id/apply (safety.rolesheets.manage): one command; 409 IMPACT_CHANGED when the people changed meanwhile. */
export const applySheet = (api: ApiClient, id: string, body: SheetDraftBody & { version: number; impactFingerprint: string }, idempotencyKey: string) =>
  api.post(`/safety/rolesheets/${seg(id)}/apply`, { body, schema: applyAnswer, idempotencyKey })

/** POST /safety/rolesheets/:id/archive · /restore (safety.rolesheets.manage). */
export const setSheetStatus = async (api: ApiClient, id: string, to: 'ARCHIVED' | 'ACTIVE', version: number, idempotencyKey: string) =>
  (await api.post(`/safety/rolesheets/${seg(id)}/${to === 'ARCHIVED' ? 'archive' : 'restore'}`, { body: { version }, schema: z.object({ roleSheet: sheetSchema }), idempotencyKey })).roleSheet

/** The record types a file of this page is uploaded to (the generic files routes). */
export type RiskFileRecord = 'RiskAssessment' | 'RiskAssessmentSignature' | 'RiskMeasure'

const DOCUMENT_TYPES = new Set(['application/pdf', 'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 'application/vnd.oasis.opendocument.text'])

/** A file onto a record (files.upload): announce, send the bytes, confirm; its id back. A picture is an ATTACHMENT (DOCUMENT takes none). */
export async function uploadFile(api: ApiClient, record: { type: RiskFileRecord; id: string; companyId: string }, file: File): Promise<{ id: string; sha256: string; status: string }> {
  const bytes = await file.arrayBuffer()
  const contentType = file.type || 'application/pdf'
  const sha256 = await sha256Hex(bytes)
  const { file: stored, upload } = await requestUpload(api, {
    companyId: record.companyId,
    record: { type: record.type, id: record.id },
    kind: DOCUMENT_TYPES.has(contentType) && record.type !== 'RiskMeasure' ? 'DOCUMENT' : 'ATTACHMENT',
    name: file.name || 'file.pdf',
    contentType,
    sizeBytes: bytes.byteLength,
    sha256,
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  const done = await completeUpload(api, stored.id)
  return { id: stored.id, sha256, status: done.file.status }
}

/** The fingerprint of a file on THIS device (Web Crypto): what the freeze will seal, shown before it is sent. */
export const fingerprintOf = async (file: File): Promise<string> => sha256Hex(await file.arrayBuffer())

export { presignedSchema }
