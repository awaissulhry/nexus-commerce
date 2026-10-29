import { z } from 'zod'
import { CHECK_CODES, CR_VI_EVIDENCE, CR_VI_METHODS, EVIDENCE_RULES, LOT_DOCUMENT_KINDS, SETTING_SOURCES, type CrViEvidence, type EvidenceRule, type LotDocumentKind } from '@nexus/factory-domain/quality/lab/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { lotSchema, type Lot } from '../../quality/_shared/lots'

/**
 * Every call Tests & substances makes (SCR-054; apps/factory-api modules/quality/lab, B-W1-34): the lot with its results,
 * supplier documents and release checklist, a Cr VI result with its report, a supplier document, the decisions (release
 * and reject with the typed lot code, block, unblock, clear the receiver's hold) and the Cr VI evidence rule (Q14). The
 * shapes mirror the API's contract; unknown fields are ignored. mg/kg values are decimal strings with three decimals.
 * A file never passes through these JSON routes: it is announced, sent straight to the store, and the record/attach call
 * confirms it.
 */

export const checkSchema = z.object({ code: z.enum(CHECK_CODES), state: z.enum(['OK', 'OPEN', 'NOT_NEEDED']), words: z.string(), fix: z.string().nullable() })
export type LotCheck = z.infer<typeof checkSchema>
export const checklistSchema = z.object({ mode: z.enum(['RELEASE', 'UNBLOCK']), checks: z.array(checkSchema), open: z.array(checkSchema), ready: z.boolean(), words: z.string() })
export type LotChecklist = z.infer<typeof checklistSchema>

const fileRef = z.object({ id: z.string(), originalName: z.string(), status: z.string() }).nullable()

export const resultSchema = z.object({
  id: z.string(),
  lotId: z.string(),
  test: z.string(),
  method: z.string(),
  valueMgKg: z.string().nullable(),
  belowDetectionLimit: z.boolean(),
  detectionLimitMgKg: z.string().nullable(),
  unit: z.string(),
  limitMgKg: z.string(),
  verdict: z.enum(['PASS', 'FAIL']),
  lab: z.string(),
  reportNumber: z.string().nullable(),
  testedOn: z.string(),
  evidence: z.enum(CR_VI_EVIDENCE),
  article: z.string().nullable(),
  periodFrom: z.string().nullable(),
  periodTo: z.string().nullable(),
  fileId: z.string(),
  supersedesId: z.string().nullable(),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  words: z.string(),
  file: fileRef.optional(),
  superseded: z.boolean().optional(),
})
export type LabResult = z.infer<typeof resultSchema>

export const documentSchema = z.object({
  id: z.string(),
  lotId: z.string(),
  kind: z.enum(LOT_DOCUMENT_KINDS),
  fileId: z.string(),
  validTo: z.string().nullable(),
  status: z.enum(['ACTIVE', 'ARCHIVED']),
  note: z.string().nullable(),
  createdAt: z.string(),
  createdById: z.string().nullable(),
  file: fileRef.optional(),
  inForce: z.boolean().optional(),
})
export type LotDocument = z.infer<typeof documentSchema>

export const ruleSchema = z.object({ crViEvidenceRule: z.enum(EVIDENCE_RULES), source: z.enum(SETTING_SOURCES), words: z.string() })
export type LotRule = z.infer<typeof ruleSchema>

export const lotDetailSchema = z.object({ lot: lotSchema, rule: ruleSchema, results: z.array(resultSchema), documents: z.array(documentSchema), checklist: checklistSchema })
export type LotDetail = z.infer<typeof lotDetailSchema>

export const workOrderUseSchema = z.object({
  workOrderId: z.string(),
  number: z.string().nullable(),
  batchNumber: z.string().nullable(),
  status: z.string().nullable(),
  issued: z.string(),
  returned: z.string(),
  atWorkOrder: z.string(),
})
export type WorkOrderUse = z.infer<typeof workOrderUseSchema>

export const registerAnswerSchema = z.object({ opened: z.boolean(), entryId: z.string().nullable(), reference: z.string().nullable(), shippedGoods: z.boolean().nullable(), words: z.string() })
export type RegisterAnswer = z.infer<typeof registerAnswerSchema>

export const recordAnswerSchema = z.object({
  result: resultSchema,
  effect: z.string(),
  lot: lotSchema,
  checklist: checklistSchema,
  trace: z.object({ law: z.string(), workOrders: z.array(workOrderUseSchema), register: registerAnswerSchema.nullable() }).nullable(),
})
export type RecordAnswer = z.infer<typeof recordAnswerSchema>

export const settingsSchema = z.object({
  companyId: z.string().nullable(),
  crViEvidenceRule: z.enum(EVIDENCE_RULES),
  source: z.enum(SETTING_SOURCES),
  words: z.string(),
  default: z.enum(EVIDENCE_RULES),
  legalLimitMgKg: z.string(),
  law: z.string(),
  version: z.number(),
  updatedAt: z.string().nullable(),
  updatedById: z.string().nullable(),
})
export type LabSettings = z.infer<typeof settingsSchema>

const decidedSchema = z.object({ lot: lotSchema, checklist: checklistSchema })
export type Decided = z.infer<typeof decidedSchema> & { trace?: { workOrders: WorkOrderUse[] } }

const enc = encodeURIComponent
const lotPath = (lotId: string) => `/quality/lots/${enc(lotId)}`

/** GET /quality/lots/:lotId: the lot, the rule in force, its results, documents and the release checklist for the viewer. */
export function getLot(api: ApiClient, lotId: string, signal?: AbortSignal): Promise<LotDetail> {
  return api.get(lotPath(lotId), { schema: lotDetailSchema, signal })
}

/** GET /quality/settings: the Cr VI evidence rule in force for the company (or tenant-wide without one). */
export async function getSettings(api: ApiClient, companyId: string | null, signal?: AbortSignal): Promise<LabSettings> {
  const answer = await api.get('/quality/settings', { query: companyId ? { companyId } : {}, schema: z.object({ settings: settingsSchema }), signal })
  return answer.settings
}

/** PUT /quality/settings: loosening needs the reason, then the step-up (the caller's guard). */
export async function saveSettings(api: ApiClient, input: { companyId: string | null; rule: EvidenceRule; version: number; reason: string | null }): Promise<LabSettings> {
  const answer = await api.request('PUT', '/quality/settings', {
    body: { companyId: input.companyId, crViEvidenceRule: input.rule, version: input.version, reason: input.reason },
    schema: z.object({ settings: settingsSchema, previousRule: z.enum(EVIDENCE_RULES) }),
    idempotencyKey: newIdempotencyKey(),
  })
  return answer.settings
}

/** The report's or document's file as the API announces it. */
export interface PickedFile {
  readonly name: string
  readonly contentType: string
  readonly size: number
  readonly bytes: ArrayBuffer
}

/** Reads a chosen file (its bytes are hashed and sent to the store). */
export async function pickedFile(file: File): Promise<PickedFile> {
  return { name: file.name, contentType: file.type || 'application/pdf', size: file.size, bytes: await file.arrayBuffer() }
}

const announced = z.object({ file: z.object({ id: z.string() }).passthrough(), upload: presignedSchema })

/** Announces the file on the lot (POST …/results/report or …/documents/upload), sends it to the store; the file's id. */
async function upload(api: ApiClient, path: string, file: PickedFile): Promise<string> {
  const sha256 = await sha256Hex(file.bytes)
  const answer = await api.post(path, {
    body: { originalName: file.name, contentType: file.contentType, sizeBytes: file.size, sha256 },
    schema: announced,
    idempotencyKey: newIdempotencyKey(),
  })
  await putToStore(answer.upload as Presigned, file.bytes)
  return answer.file.id
}

export interface ResultInput {
  readonly method: string
  readonly valueMgKg: string | null
  readonly belowDetectionLimit: boolean
  readonly detectionLimitMgKg: string | null
  readonly lab: string
  readonly reportNumber: string | null
  readonly testedOn: string
  readonly evidence: CrViEvidence
  readonly article: string | null
  readonly periodFrom: string | null
  readonly periodTo: string | null
  readonly note: string | null
}

/** Announces the report, sends it, then records the result on the lot (the record call confirms the file). */
export async function recordResult(api: ApiClient, lotId: string, version: number, input: ResultInput, file: PickedFile): Promise<RecordAnswer> {
  const fileId = await upload(api, `${lotPath(lotId)}/results/report`, file)
  return api.post(`${lotPath(lotId)}/results`, {
    body: {
      version,
      test: 'CR_VI',
      method: input.method,
      ...(input.belowDetectionLimit ? { belowDetectionLimit: true, detectionLimitMgKg: input.detectionLimitMgKg } : { valueMgKg: input.valueMgKg }),
      lab: input.lab,
      reportNumber: input.reportNumber,
      testedOn: input.testedOn,
      evidence: input.evidence,
      ...(input.evidence === 'SUPPLIER_REPORT' ? { article: input.article, periodFrom: input.periodFrom, periodTo: input.periodTo } : {}),
      note: input.note,
      fileId,
    },
    schema: recordAnswerSchema,
    idempotencyKey: newIdempotencyKey(),
  })
}

export interface DocumentInput {
  readonly kind: LotDocumentKind
  readonly validTo: string | null
  readonly note: string | null
}

/** Announces a supplier document, sends it, then attaches it to the lot (the attach call confirms the file). */
export async function attachDocument(api: ApiClient, lotId: string, input: DocumentInput, file: PickedFile): Promise<{ documents: LotDocument[]; checklist: LotChecklist }> {
  const fileId = await upload(api, `${lotPath(lotId)}/documents/upload`, file)
  return api.post(`${lotPath(lotId)}/documents`, {
    body: { fileId, kind: input.kind, validTo: input.validTo, note: input.note },
    schema: z.object({ documents: z.array(documentSchema), checklist: checklistSchema }),
    idempotencyKey: newIdempotencyKey(),
  })
}

export type LotDecision = 'release' | 'reject' | 'block' | 'unblock' | 'clearHold'

const DECISION_PATH: Record<LotDecision, string> = { release: 'release', reject: 'reject', block: 'block', unblock: 'unblock', clearHold: 'hold/clear' }

/** A decision on the lot with its version: release and reject take the typed code; the others the reason. */
export async function decideLot(api: ApiClient, lotId: string, decision: LotDecision, body: { version: number; confirmCode?: string; reason?: string; note?: string | null }): Promise<Decided> {
  const payload =
    decision === 'release'
      ? { version: body.version, confirmCode: body.confirmCode ?? '', note: body.note ?? null }
      : decision === 'reject'
        ? { version: body.version, confirmCode: body.confirmCode ?? '', reason: body.reason ?? '' }
        : { version: body.version, reason: body.reason ?? '' }
  return api.post(`${lotPath(lotId)}/${DECISION_PATH[decision]}`, {
    body: payload,
    schema: decidedSchema.extend({ trace: z.object({ workOrders: z.array(workOrderUseSchema) }).optional() }),
    idempotencyKey: newIdempotencyKey(),
  })
}

/** GET /files/<id>/download: a presigned GET that lives 60 seconds (the report or document, as an attachment). */
export async function downloadAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${enc(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

export { CR_VI_METHODS, type Lot }
