import { z } from 'zod'
import { INSPECTION_LEVELS } from '@nexus/factory-domain/quality/aql/iso2859'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { downloadLink } from '../../../../record-panels/api'

/**
 * B-W2b-127 — every call of Inspections in depth, each answer checked against the shape the API gives (unknown fields are
 * dropped, so a new field never breaks a page). The final inspection's bench sheet and AQL (B-W2b-97, B-W2b-93), the
 * amendments of the three kinds of record (B-W2b-123), the inspection report and its share (B-W2b-123), the incoming and
 * in-process inspections (B-W2b-98, B-W2b-99), the cause codes (B-W2b-90) and the plans that apply to a work order (B-W2b-97).
 * The API's English words (`words`, `because`, `message`) are never drawn: the screens say their own from the facts.
 */

const itEn = z.object({ it: z.string(), en: z.string() })
const klass = z.enum(['CRITICAL', 'MAJOR', 'MINOR'])

// ---- the bench sheet of a final inspection on a plan (GET /quality/inspections/:id/sheet) --------------------------------------

const resultSchema = z.object({
  id: z.string(),
  sampleIndex: z.number(),
  outcome: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']),
  value: z.string().nullable(),
  note: z.string().nullable(),
  photos: z.array(z.object({ id: z.string(), status: z.string() })),
  recordedBy: z.enum(['FLOOR', 'OFFICE']),
  recordedAt: z.string(),
})
export type SheetResult = z.infer<typeof resultSchema>

export const sheetCheckSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  type: z.string(),
  checkClass: klass.nullable(),
  mandatory: z.boolean(),
  photoRequired: z.boolean(),
  takesResult: z.boolean(),
  onChart: z.boolean(),
  choices: z.array(z.string()),
  results: z.array(resultSchema),
})
export type SheetCheck = z.infer<typeof sheetCheckSchema>

const pointSchema = z.object({
  pointCode: z.string(),
  checkCode: z.string().nullable(),
  label: z.string(),
  size: z.string().nullable(),
  // B-W2b-283 (FU1:05): a point of the revision's approved measurement spec (B-W2b-224's SPEC), its words per size, and a
  // value's band when the spec's sides differ (nominal − minus … nominal + plus).
  source: z.enum(['PLAN', 'SIZE_CHART', 'PROFILE', 'SPEC', 'TYPED']),
  nominal: z.string().nullable(),
  tolerance: z.string().nullable(),
  uom: z.string().nullable(),
  spec: z.string().optional(),
  values: z.array(z.object({ id: z.string(), size: z.string(), sampleIndex: z.number(), measured: z.string(), nominal: z.string(), tolerance: z.string(), toleranceMinus: z.string().nullable().optional(), tolerancePlus: z.string().nullable().optional(), pass: z.boolean() })),
})
export type ChartPoint = z.infer<typeof pointSchema>

export const sheetSchema = z.object({
  inspection: z.object({ id: z.string(), number: z.string().nullable(), workOrderId: z.string(), status: z.string(), version: z.number(), lotSize: z.number(), sampleSize: z.number(), codeLetter: z.string().nullable(), decidedAt: z.string().nullable() }),
  plan: z.object({ planId: z.string(), code: z.string(), name: z.string(), versionId: z.string(), number: z.number(), samplingMethod: z.enum(['AQL_PROFILE', 'FIXED']) }),
  checks: z.array(sheetCheckSchema),
  checksNow: z.object({ answered: z.number(), outOf: z.number(), failed: z.array(z.string()), failedCritical: z.array(z.string()), mandatoryMissing: z.array(z.string()) }),
  chart: z.object({
    points: z.array(pointSchema),
    values: z.number(),
    outOfTolerance: z.number(),
    madeToMeasure: z.object({ garmentType: z.string(), revision: z.number(), size: z.string(), points: z.array(z.object({ code: z.string(), name: z.string(), nominal: z.string(), uom: z.string() })), pointsWithout: z.array(z.string()) }).nullable(),
  }),
  identity: z.object({
    mode: z.enum(['SERIAL', 'BATCH']),
    target: z.number(),
    matched: z.number(),
    missing: z.array(z.string()),
    missingCount: z.number(),
    unknown: z.array(z.string()),
    noNumber: z.number(),
    done: z.boolean(),
    ok: z.boolean().nullable(),
    scans: z.number(),
    batchNumber: z.string().nullable(),
  }),
  photos: z.object({
    slots: z.array(z.object({ code: z.string(), labelIt: z.string(), labelEn: z.string(), mandatory: z.boolean(), photos: z.number(), state: z.enum(['TAKEN', 'MISSING', 'NOT_APPLICABLE', 'OPEN']) })),
    waiting: z.array(z.string()),
    mandatoryMissing: z.array(z.string()),
  }),
  counter: z.object({
    sampleSize: z.number(),
    inspected: z.number(),
    remaining: z.number(),
    classes: z.array(z.object({ defectClass: klass, aql: z.string(), accept: z.number(), reject: z.number(), found: z.number(), state: z.enum(['ok', 'limit', 'reject']), spare: z.number().nullable() })),
    verdict: z.enum(['open', 'accept', 'reject']),
    stop: z.object({ stop: z.boolean(), source: z.enum(['PLAN', 'COMPANY', 'TENANT', 'DEFAULT']) }),
  }),
  result: z.object({ resultNow: z.enum(['PASS', 'FAIL']), byCountsOnly: z.boolean() }),
  sign: z.object({ pass: z.object({ held: z.boolean(), reasons: z.array(z.string()) }), fail: z.object({ held: z.boolean(), reasons: z.array(z.string()) }) }),
  may: z.object({ record: z.boolean() }),
})
export type Sheet = z.infer<typeof sheetSchema>

/** `GET /quality/inspections/:id/sheet?language=` (quality.inspections.view): the plan's checks, chart, identity, photos, counter. */
export function getSheet(api: ApiClient, inspectionId: string, language: string, signal?: AbortSignal): Promise<Sheet> {
  return api.get(`/quality/inspections/${encodeURIComponent(inspectionId)}/sheet`, { query: { language }, schema: sheetSchema, signal })
}

export interface ResultBody {
  readonly checkCode: string
  readonly sampleIndex: number
  /** null: take the answer back. */
  readonly outcome: 'PASS' | 'FAIL' | 'NOT_APPLICABLE' | null
  readonly value?: string | null
  readonly note?: string | null
}

/** `PUT /quality/inspections/:id/results` (its inspector or assignee): the answers of the rows sent; the answer is the new sheet. */
export function putResults(api: ApiClient, inspectionId: string, body: { version: number; results: readonly ResultBody[] }): Promise<Sheet> {
  return api.request('PUT', `/quality/inspections/${encodeURIComponent(inspectionId)}/results`, { body, schema: sheetSchema, idempotencyKey: newIdempotencyKey() })
}

export interface MeasurementBody {
  readonly checkCode?: string | null
  readonly pointCode?: string | null
  readonly size?: string | null
  readonly sampleIndex: number
  /** A decimal as text; null takes the value back. */
  readonly measured: string | null
}

/** `PUT /quality/inspections/:id/measurements`: the values sent (the plan binds nominal ± tolerance); the answer is the new sheet. */
export function putMeasurements(api: ApiClient, inspectionId: string, body: { version: number; measurements: readonly MeasurementBody[] }): Promise<Sheet> {
  return api.request('PUT', `/quality/inspections/${encodeURIComponent(inspectionId)}/measurements`, { body, schema: sheetSchema, idempotencyKey: newIdempotencyKey() })
}

// ---- Sample & AQL (GET /quality/aql/inspections/:id; B-W2b-93) -----------------------------------------------------------------

const planClassSchema = z.object({
  defectClass: klass,
  aql: z.string(),
  accept: z.number(),
  reject: z.number(),
  planLetter: z.string().nullable(),
  planSampleSize: z.number().nullable(),
  arrow: z.enum(['down', 'up']).nullable(),
  locked: z.boolean(),
})
export const aqlPlanSchema = z.object({
  lotSize: z.number(),
  level: z.enum(INSPECTION_LEVELS),
  levelText: z.string(),
  codeLetter: z.string().nullable(),
  sampleSize: z.number(),
  hundredPercent: z.boolean(),
  samplesDiffer: z.boolean(),
  classes: z.array(planClassSchema),
})
export type AqlPlan = z.infer<typeof aqlPlanSchema>

const aqlResultSchema = z.object({
  verdict: z.enum(['open', 'accept', 'reject']),
  classes: z.array(z.object({ defectClass: klass, aql: z.string(), accept: z.number(), reject: z.number(), found: z.number(), state: z.enum(['ok', 'limit', 'reject']), spare: z.number().nullable() })),
  progress: z.object({ inspected: z.number(), sampleSize: z.number(), remaining: z.number() }).nullable(),
  resultNow: z.enum(['PASS', 'FAIL']),
  byCountsOnly: z.boolean(),
})
export type AqlResult = z.infer<typeof aqlResultSchema>

const chainSchema = z.object({
  profile: z.object({ id: z.string(), code: z.string(), name: z.string(), inspectionLevel: z.string(), aqlMajor: z.string(), aqlMinor: z.string() }).nullable(),
  source: z.string(),
  sourceWords: itEn,
  steps: z.array(z.object({ source: z.string(), profileId: z.string().nullable(), profileCode: z.string().nullable(), skipped: z.string().nullable() })),
})
export type Chain = z.infer<typeof chainSchema>

export const inspectionAqlSchema = z.object({
  inspection: z.object({ id: z.string(), status: z.string(), lotSize: z.number(), sampleSize: z.number(), inspectionLevel: z.string(), codeLetter: z.string().nullable(), aqlMajor: z.string(), aqlMinor: z.string(), acceptMajor: z.number(), acceptMinor: z.number(), planVersionId: z.string().nullable(), version: z.number() }),
  profile: z.object({ id: z.string(), code: z.string(), name: z.string(), active: z.boolean() }).nullable(),
  chain: chainSchema,
  plan: aqlPlanSchema.nullable(),
  matchesProfile: z.boolean().nullable(),
  frozen: z.boolean(),
  fixedSample: z.boolean(),
  counts: z.object({ critical: z.number(), major: z.number(), minor: z.number() }),
  result: aqlResultSchema,
  mayApply: z.boolean(),
})
export type InspectionAql = z.infer<typeof inspectionAqlSchema>

/** `GET /quality/aql/inspections/:id` (quality.inspections.view): the derivation, the profile and its chain, the result now. */
export function getInspectionAql(api: ApiClient, inspectionId: string, signal?: AbortSignal): Promise<InspectionAql> {
  return api.get(`/quality/aql/inspections/${encodeURIComponent(inspectionId)}`, { schema: inspectionAqlSchema, signal })
}

/** `POST /quality/aql/inspections/:id/profile` (its inspector; before counting starts): the chain's profile, or another with a reason. */
export function applyProfile(api: ApiClient, inspectionId: string, body: { version: number; profileId: string | null; reason: string | null }, key: string): Promise<InspectionAql> {
  return api.post(`/quality/aql/inspections/${encodeURIComponent(inspectionId)}/profile`, { body, schema: inspectionAqlSchema, idempotencyKey: key })
}

export const profilePickSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), levelText: z.string(), aqlMajor: z.string(), aqlMinor: z.string(), isDefault: z.boolean(), active: z.boolean() })
export type ProfilePick = z.infer<typeof profilePickSchema>

/** `GET /quality/aql/profiles?companyId&active=true` (quality.aql.view): the profiles another one may be picked from. */
export async function listProfiles(api: ApiClient, companyId: string, signal?: AbortSignal): Promise<ProfilePick[]> {
  return (await api.get('/quality/aql/profiles', { query: { companyId, active: 'true' }, schema: z.object({ profiles: z.array(profilePickSchema) }), signal })).profiles
}

// ---- amendments (B-W2b-123): one shape for the three kinds of record ----------------------------------------------------------

export const AMENDED_KINDS = ['Inspection', 'IncomingInspection', 'InProcessCheck'] as const
export type AmendedKind = (typeof AMENDED_KINDS)[number]

const person = z.object({ id: z.string(), name: z.string().nullable() })
const rowRef = z.object({ type: z.string(), id: z.string(), label: z.string() })

export const correctionSchema = z.object({
  id: z.string(),
  ref: z.number().nullable(),
  field: z.string(),
  fieldWords: z.string(),
  row: rowRef.nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  beforeWords: z.string(),
  afterWords: z.string(),
  reason: z.string(),
  state: z.enum(['WAITING', 'SIGNED', 'REFUSED']),
  askedBy: person,
  askedAt: z.string(),
  signatureSha256: z.string(),
  mine: z.boolean(),
  answer: z.object({ id: z.string(), kind: z.enum(['SIGNED', 'REFUSED']), by: person, at: z.string(), reason: z.string().nullable(), signatureSha256: z.string() }).nullable(),
})
export type Correction = z.infer<typeof correctionSchema>

export const fieldSchema = z.object({
  field: z.string(),
  row: rowRef.nullable(),
  kind: z.enum(['note', 'text', 'value', 'decimal', 'zone', 'cause']),
  words: z.string(),
  value: z.string().nullable(),
  valueWords: z.string(),
  nullable: z.boolean(),
  amendedBy: z.string().nullable(),
  waiting: z.string().nullable(),
  choices: z.array(z.string()).optional(),
})
export type AmendField = z.infer<typeof fieldSchema>

export const amendmentsSchema = z.object({
  record: z.object({ type: z.enum(AMENDED_KINDS), id: z.string(), label: z.string(), status: z.string(), signed: z.boolean(), companyId: z.string(), siteId: z.string(), amended: z.boolean() }),
  corrections: z.array(correctionSchema),
  fields: z.array(fieldSchema),
  waiting: z.number(),
  may: z.object({ request: z.boolean(), sign: z.boolean() }),
})
export type Amendments = z.infer<typeof amendmentsSchema>

/** The API path of a record's amendments. */
export function amendmentsPath(kind: AmendedKind, id: string): string {
  const at = encodeURIComponent(id)
  return kind === 'Inspection' ? `/quality/inspections/${at}/amendments` : kind === 'IncomingInspection' ? `/quality/incoming/${at}/amendments` : `/quality/inprocess/checks/${at}/amendments`
}

/** `GET …/amendments` (the record's view permission): its corrections, the fields a correction may take, may {request, sign}. */
export function getAmendments(api: ApiClient, kind: AmendedKind, id: string, signal?: AbortSignal): Promise<Amendments> {
  return api.get(amendmentsPath(kind, id), { schema: amendmentsSchema, signal })
}

export interface AmendBody {
  readonly field: string
  readonly row: { readonly type: string; readonly id: string } | null
  /** The new value as text; null clears a field that may be empty. */
  readonly after: string | null
  readonly reason: string
}

/** `POST …/amendments` (quality.amendments.request): the request, signed by who asks; it waits for the second signature. */
export async function requestAmendment(api: ApiClient, kind: AmendedKind, id: string, body: AmendBody, key: string): Promise<Amendments> {
  return (await api.post(amendmentsPath(kind, id), { body, schema: z.object({ amendmentId: z.string(), amendments: amendmentsSchema }), idempotencyKey: key })).amendments
}

/** `POST /quality/amendments/:id/sign` (quality.amendments.sign, a fresh code; never who asked). */
export async function signAmendment(api: ApiClient, amendmentId: string, key: string): Promise<Amendments> {
  return (await api.post(`/quality/amendments/${encodeURIComponent(amendmentId)}/sign`, { body: {}, schema: z.object({ answerId: z.string(), amendments: amendmentsSchema }), idempotencyKey: key })).amendments
}

/** `POST /quality/amendments/:id/refuse` (quality.amendments.sign; the reason; no code: a refusal changes nothing). */
export async function refuseAmendment(api: ApiClient, amendmentId: string, reason: string, key: string): Promise<Amendments> {
  return (await api.post(`/quality/amendments/${encodeURIComponent(amendmentId)}/refuse`, { body: { reason }, schema: z.object({ answerId: z.string(), amendments: amendmentsSchema }), idempotencyKey: key })).amendments
}

// ---- the inspection report (B-W2b-123) ----------------------------------------------------------------------------------------

const versionSchema = z.object({ id: z.string(), version: z.number(), language: z.string(), number: z.string().nullable(), fileId: z.string(), createdAt: z.string(), createdBy: person.nullable() })
export type ReportVersion = z.infer<typeof versionSchema>

export const reportsSchema = z.object({
  inspection: z.object({ id: z.string(), number: z.string(), status: z.string(), workOrderId: z.string(), signed: z.boolean() }),
  versions: z.array(versionSchema),
  shipments: z.array(z.object({ id: z.string(), number: z.string(), status: z.string(), customer: z.string().nullable(), shareable: z.boolean() })),
  shares: z.array(z.object({ shipmentId: z.string(), shipmentNumber: z.string().nullable(), fileId: z.string(), version: z.number(), live: z.boolean(), sharedAt: z.string() })),
  ready: z.object({ ok: z.boolean() }),
  may: z.object({ make: z.boolean(), share: z.boolean() }),
})
export type Reports = z.infer<typeof reportsSchema>

/** `GET /quality/inspections/:id/reports`: the kept versions, the shipments that carry its goods, where a version is shared. */
export function getReports(api: ApiClient, inspectionId: string, signal?: AbortSignal): Promise<Reports> {
  return api.get(`/quality/inspections/${encodeURIComponent(inspectionId)}/reports`, { schema: reportsSchema, signal })
}

/** `GET /quality/inspections/:id/report?language=`: the report PDF with the PREVIEW banner, made now and kept nowhere. */
export function previewReport(api: ApiClient, inspectionId: string, language: 'it' | 'en', signal?: AbortSignal): Promise<Uint8Array> {
  return api.bytes(`/quality/inspections/${encodeURIComponent(inspectionId)}/report`, { query: { language }, signal })
}

/** `POST /quality/inspections/:id/reports` (quality.documents.make): a kept version (the same contents give it back: `made` false). */
export function keepReport(api: ApiClient, inspectionId: string, language: 'it' | 'en', key: string): Promise<{ report: ReportVersion; made: boolean }> {
  return api.post(`/quality/inspections/${encodeURIComponent(inspectionId)}/reports`, { body: { language }, schema: z.object({ report: versionSchema, made: z.boolean() }), idempotencyKey: key })
}

const shareAnswerSchema = z.object({
  shared: z.object({ shipmentId: z.string(), shipmentNumber: z.string(), fileId: z.string(), version: z.number(), copied: z.boolean(), withdrawn: z.number() }),
  link: z.object({ links: z.array(z.unknown()), skipped: z.array(z.unknown()) }).nullable(),
})
export type ShareAnswer = z.infer<typeof shareAnswerSchema>

/** `POST /quality/inspections/:id/reports/share` (quality.documents.share; `send` shipping.manage): a copy on the shipment's documents link. */
export function shareReport(api: ApiClient, inspectionId: string, body: { shipmentId: string; version?: number; send?: Record<string, never> | null }, key: string): Promise<ShareAnswer> {
  return api.post(`/quality/inspections/${encodeURIComponent(inspectionId)}/reports/share`, { body, schema: shareAnswerSchema, idempotencyKey: key })
}

/** A kept file's address (a presigned GET lives 60 seconds; a same-origin path goes through this app's /api). */
export async function fileAddress(api: ApiClient, fileId: string): Promise<string> {
  const { download } = await downloadLink(api, fileId)
  return download.url.startsWith('/') && !download.url.startsWith('//') ? `/api${download.url}` : download.url
}

// ---- the incoming inspections (B-W2b-98, B-W2b-111) ----------------------------------------------------------------------------

export const incomingRowSchema = z.object({
  id: z.string(),
  number: z.string(),
  status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']),
  companyId: z.string(),
  siteId: z.string(),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string() }).nullable(),
  item: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  receipt: z.object({ id: z.string(), workOrderId: z.string() }).nullable(),
  lotSize: z.string(),
  uom: z.string(),
  sampleSize: z.number(),
  done: z.number(),
  computedResult: z.enum(['PASS', 'FAIL']).nullable(),
  decision: z.object({ accepted: z.string(), rejected: z.string(), toSort: z.string() }).nullable(),
  inspectorKind: z.enum(['FLOOR', 'OFFICE']).nullable(),
  dueAt: z.string().nullable(),
  createdAt: z.string(),
  // B-W2b-127 (the list's own fields; optional so an older API still reads).
  supplier: z.object({ id: z.string(), name: z.string() }).nullable().optional().default(null),
  plan: z.object({ code: z.string(), number: z.number() }).nullable().optional().default(null),
  amended: z.boolean().optional().default(false),
})
export type IncomingRow = z.infer<typeof incomingRowSchema>

/** `GET /quality/incoming?status&limit` (quality.incoming.view): newest first; no person in a list. */
export async function listIncoming(api: ApiClient, query: { status?: 'OPEN' | 'DECIDED' | 'CANCELLED' | null; limit: number }, signal?: AbortSignal): Promise<{ rows: IncomingRow[]; more: boolean }> {
  const answer = await api.get('/quality/incoming', { query: { ...(query.status ? { status: query.status } : {}), limit: query.limit }, schema: z.object({ items: z.array(incomingRowSchema), nextCursor: z.string().nullable() }), signal })
  return { rows: answer.items, more: answer.nextCursor !== null }
}

const hideSchema = z.object({
  id: z.string(),
  hideId: z.string(),
  code: z.string(),
  seq: z.number(),
  receivedArea: z.object({ area: z.string(), uom: z.string() }),
  measured: z.boolean(),
  declaredArea: z.string().nullable(),
  measuredArea: z.string(),
  areaUom: z.string(),
  areaCheck: z.object({ differencePercent: z.string(), outcome: z.enum(['WITHIN', 'SHORT', 'OVER']) }).nullable(),
  shadeGroup: z.object({ id: z.string(), label: z.string(), outOfShade: z.boolean() }).nullable(),
  grade: z.object({ id: z.string(), code: z.string() }).nullable(),
  marks: z.array(z.object({ kind: z.string(), code: z.string().nullable(), defectClass: klass.nullable(), labelIt: z.string().nullable(), labelEn: z.string().nullable() })),
  worstClass: klass.nullable(),
  decision: z.enum(['ACCEPTED', 'REJECTED', 'TO_SORT']).nullable(),
  note: z.string().nullable(),
})
export type IncomingHide = z.infer<typeof hideSchema>

export const incomingSchema = z.object({
  inspection: z.object({
    id: z.string(),
    number: z.string(),
    status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']),
    companyId: z.string(),
    siteId: z.string(),
    subject: z.enum(['LOT', 'WORKSHOP']),
    lotSize: z.string(),
    uom: z.string(),
    byHide: z.boolean(),
    sampleSize: z.number(),
    codeLetter: z.string().nullable(),
    found: z.object({ critical: z.number(), major: z.number(), minor: z.number() }),
    computedResult: z.enum(['PASS', 'FAIL']).nullable(),
    overrideReason: z.string().nullable(),
    decision: z.object({ accepted: z.string(), rejected: z.string(), toSort: z.string() }).nullable(),
    decidedAt: z.string().nullable(),
    signatureSha256: z.string().nullable(),
    cancelledAt: z.string().nullable(),
    cancelReason: z.string().nullable(),
    dueAt: z.string().nullable(),
    note: z.string().nullable(),
    version: z.number(),
    createdAt: z.string(),
  }),
  lot: z.object({ id: z.string(), code: z.string(), qualityStatus: z.string(), item: z.object({ id: z.string(), code: z.string(), name: z.string() }), supplier: z.object({ id: z.string(), name: z.string() }).nullable() }).nullable(),
  receipt: z.object({ workOrder: z.object({ id: z.string(), number: z.string() }), workshop: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable() }).nullable(),
  plan: z.object({ planId: z.string(), code: z.string(), name: z.string(), versionId: z.string(), number: z.number() }).nullable(),
  sampling: z.object({ method: z.enum(['AQL', 'FIXED', 'WHOLE']), profile: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(), plan: aqlPlanSchema.nullable() }),
  progress: z.object({ done: z.number(), sampleSize: z.number(), remaining: z.number(), decided: z.number(), accepted: z.number(), rejected: z.number(), toSort: z.number(), undecided: z.number() }),
  result: aqlResultSchema,
  hides: z.array(hideSchema),
  areaCheck: z.object({ uom: z.string(), tolerancePercent: z.string(), hides: z.number(), differencePercent: z.string().nullable(), outcome: z.enum(['WITHIN', 'SHORT', 'OVER']).nullable(), opensClaim: z.boolean() }).nullable(),
  checks: z.array(z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), checkClass: klass.nullable(), mandatory: z.boolean(), answers: z.array(z.object({ id: z.string(), sampleIndex: z.number(), outcome: z.string(), value: z.string().nullable(), note: z.string().nullable() })) })),
  next: z
    .object({
      step: z.string(),
      words: itEn,
      lotStatus: z.string().nullable(),
      rejectedHides: z.array(z.object({ hideId: z.string(), code: z.string() })),
      toSortHides: z.array(z.object({ hideId: z.string(), code: z.string() })),
      holdPrefill: z.object({ subjectType: z.literal('Hide'), subjectIds: z.array(z.string()), reasonNote: z.string() }).nullable(),
    })
    .nullable(),
  inspector: z.object({ kind: z.enum(['FLOOR', 'OFFICE']).nullable(), name: z.string().nullable(), hidden: z.boolean() }),
})
export type Incoming = z.infer<typeof incomingSchema>

/** `GET /quality/incoming/:id` (quality.incoming.view): the record with its lot, sample, hides, checks, decision and next step. */
export function getIncoming(api: ApiClient, id: string, signal?: AbortSignal): Promise<Incoming> {
  return api.get(`/quality/incoming/${encodeURIComponent(id)}`, { schema: incomingSchema, signal })
}

// ---- the in-process checks (B-W2b-99) ------------------------------------------------------------------------------------------

export const INLINE_KINDS = ['FIRST_PIECE', 'CUTTING', 'ROVING', 'END_OF_LINE'] as const
export type InlineKind = (typeof INLINE_KINDS)[number]

const inlineRowFields = {
  id: z.string(),
  kind: z.enum(INLINE_KINDS),
  status: z.enum(['OPEN', 'DECIDED', 'CANCELLED']),
  outcome: z.string().nullable(),
  siteId: z.string(),
  companyId: z.string(),
  line: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
  workOrder: z.object({ id: z.string(), number: z.string() }).nullable(),
  bundle: z.object({ id: z.string(), code: z.string(), quantity: z.number() }).nullable(),
  operation: z.object({ id: z.string(), seq: z.number(), code: z.string(), name: z.string() }).nullable(),
  pieces: z.number(),
  defectivePieces: z.number(),
  defects: z.number(),
  dhu: z.string().nullable(),
  defect: z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), critical: z.boolean() }).nullable(),
  hasPlan: z.boolean(),
  // B-W2b-213: the AQL sample frozen at opening and the units counted, by when it is due, a rule's.
  sampleSize: z.number().nullable().optional().default(null),
  inspected: z.number().nullable().optional().default(null),
  dueAt: z.string().nullable().optional().default(null),
  openedByRule: z.boolean().optional().default(false),
  decidedAt: z.string().nullable(),
  createdAt: z.string(),
  version: z.number(),
}
export const inlineRowSchema = z.object(inlineRowFields)
export type InlineRow = z.infer<typeof inlineRowSchema>

/**
 * `GET /quality/inprocess/checks?siteId&status` (quality.inprocess.view): newest first, at most 500 per site; no inspector, no
 * operator. The office names the site: one read per site of the top bar's scope ("All sites": each of the person's sites).
 */
export async function listInline(api: ApiClient, query: { siteIds: readonly string[]; status?: 'OPEN' | 'DECIDED' | 'CANCELLED' | null }, signal?: AbortSignal): Promise<{ rows: InlineRow[]; capped: boolean }> {
  const answers = await Promise.all(
    query.siteIds.map((siteId) => api.get('/quality/inprocess/checks', { query: { siteId, ...(query.status ? { status: query.status } : {}) }, schema: z.object({ checks: z.array(inlineRowSchema), capped: z.boolean() }), signal })),
  )
  return { rows: answers.flatMap((answer) => answer.checks).sort((a, b) => b.createdAt.localeCompare(a.createdAt)), capped: answers.some((answer) => answer.capped) }
}

export const inlineSchema = z.object({
  ...inlineRowFields,
  plan: z.object({ versionId: z.string(), planId: z.string(), code: z.string(), name: z.string(), number: z.number() }).nullable(),
  checks: z.array(z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), type: z.string(), checkClass: z.string().nullable(), mandatory: z.boolean(), nominal: z.string().nullable(), tolerance: z.string().nullable(), uom: z.string().nullable() })),
  results: z.array(z.object({ id: z.string(), code: z.string(), sampleIndex: z.number(), outcome: z.enum(['PASS', 'FAIL', 'NOT_APPLICABLE']), value: z.string().nullable(), note: z.string().nullable(), recordedAt: z.string() })),
  sample: z.object({ profileCode: z.string(), codeLetter: z.string().nullable(), sampleSize: z.number().nullable() }).nullable(),
  suggested: z.enum(['GREEN', 'AMBER', 'RED']).nullable(),
  holdsRun: z.boolean().nullable(),
  inspector: z.object({ kind: z.enum(['FLOOR', 'OFFICE']), name: z.string().nullable(), workerHidden: z.boolean(), own: z.boolean() }),
  operatorHidden: z.boolean(),
  operator: z.object({ id: z.string(), name: z.string() }).nullable(),
  signatureSha256: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  cancelReason: z.string().nullable(),
  note: z.string().nullable(),
})
export type Inline = z.infer<typeof inlineSchema>

/** `GET /quality/inprocess/checks/:id` (quality.inprocess.view): one check with its plan, results, sample and signature. */
export async function getInline(api: ApiClient, id: string, signal?: AbortSignal): Promise<Inline> {
  return (await api.get(`/quality/inprocess/checks/${encodeURIComponent(id)}`, { schema: z.object({ check: inlineSchema }), signal })).check
}

export interface OpenInlineBody {
  readonly kind: InlineKind
  readonly workOrderId?: string
  readonly bundleCode?: string
  readonly note?: string | null
}

/** `POST /quality/inprocess/checks` (quality.inprocess.record): an OPEN check the bench answers (a first piece holds the run). */
export async function openInline(api: ApiClient, body: OpenInlineBody, key: string): Promise<Inline> {
  return (await api.post('/quality/inprocess/checks', { body, schema: z.object({ check: inlineSchema }), idempotencyKey: key })).check
}

// ---- the cause codes (B-W2b-90) and the plans that apply to a work order (B-W2b-97) ---------------------------------------------

export const causeSchema = z.object({ id: z.string(), code: z.string(), labelIt: z.string(), labelEn: z.string(), active: z.boolean() })
export type Cause = z.infer<typeof causeSchema>

/** `GET /quality/causes` (quality.defects.view): the group's cause codes in list order. */
export async function listCauses(api: ApiClient, signal?: AbortSignal): Promise<Cause[]> {
  return (await api.get('/quality/causes', { schema: z.object({ causes: z.array(causeSchema) }), signal })).causes
}

export const workOrderPlansSchema = z.object({
  workOrderId: z.string(),
  plans: z.array(z.object({ id: z.string(), code: z.string(), name: z.string(), approved: z.object({ id: z.string(), number: z.number() }).nullable(), matches: z.boolean(), usable: z.boolean(), suggested: z.boolean() })),
  suggestedId: z.string().nullable(),
  sampling: z.object({ method: z.enum(['FIXED', 'AQL_PROFILE']), sampleSize: z.number().nullable(), plan: aqlPlanSchema.nullable(), named: z.boolean() }).nullable(),
})
export type WorkOrderPlans = z.infer<typeof workOrderPlansSchema>

/** `GET /quality/final/work-orders/:id/plans?lotSize&planId` (quality.inspections.view): the FINAL plans, which apply, the sample. */
export function getWorkOrderPlans(api: ApiClient, workOrderId: string, query: { lotSize?: number; planId?: string | null }, signal?: AbortSignal): Promise<WorkOrderPlans> {
  return api.get(`/quality/final/work-orders/${encodeURIComponent(workOrderId)}/plans`, {
    query: { ...(query.lotSize ? { lotSize: query.lotSize } : {}), ...(query.planId ? { planId: query.planId } : {}) },
    schema: workOrderPlansSchema,
    signal,
  })
}
