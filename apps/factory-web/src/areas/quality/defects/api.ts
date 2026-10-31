import { z } from 'zod'
import { DEFECT_CLASSES, DISPOSITION_FOLLOW_UPS, DISPOSITION_MOVES, DISPOSITION_OUTCOMES, QUALITY_STAGES } from '@nexus/factory-domain/quality/defects/rules'
import { newIdempotencyKey, type ApiClient } from '../../../lib/api/client'
import { completeUpload, presignedSchema, requestUpload } from '../../../record-panels/api'
import { putToStore, sha256Hex } from '../../../record-panels/store'

/**
 * Every call of Quality › Defects & dispositions (SCR-079), with the answer's shape checked (zod; unknown fields are
 * dropped). The shapes mirror apps/factory-api modules/quality/defects/contract.ts (B-W2a-26). The library and the codes
 * are the whole group's: every write needs quality.defects.manage over every company; each carries the version read and
 * an Idempotency-Key per attempt. A disposition's approval amount is the cost grain: the API leaves it out without it.
 */

const klass = z.enum(DEFECT_CLASSES)
const stage = z.enum(QUALITY_STAGES)

export const defectSchema = z.object({
  id: z.string(),
  parentId: z.string().nullable(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  pictureFileId: z.string().nullable(),
  severity: klass.nullable(),
  zone: z.string().nullable(),
  stages: z.array(stage),
  needsDetail: z.boolean(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  usedCount: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type DefectCode = z.infer<typeof defectSchema>

export const categorySchema = defectSchema.extend({ defects: z.array(defectSchema) })
export type DefectCategory = z.infer<typeof categorySchema>

export const librarySchema = z.object({
  categories: z.array(categorySchema),
  zones: z.array(z.object({ id: z.string(), it: z.string(), en: z.string() })),
  stages: z.array(stage),
  starterMissing: z.array(z.string()),
  canManage: z.boolean(),
})
export type Library = z.infer<typeof librarySchema>

const outcome = z.enum(DISPOSITION_OUTCOMES)
const move = z.enum(DISPOSITION_MOVES)
const followUp = z.enum(DISPOSITION_FOLLOW_UPS)

export const dispositionSchema = z.object({
  id: z.string(),
  code: z.string(),
  labelIt: z.string(),
  labelEn: z.string(),
  labelI18n: z.record(z.string(), z.string()),
  icon: z.string().nullable(),
  colour: z.string().nullable(),
  outcome,
  stockMoveReason: move.nullable(),
  followUp: followUp.nullable(),
  reinspection: z.boolean(),
  stockAction: z.string(),
  approvalSeverity: klass.nullable(),
  /** Minor units, the cost grain: absent without money.cost. */
  approvalAmount: z.number().int().nullable().optional(),
  sortOrder: z.number().int(),
  active: z.boolean(),
  usedCount: z.number().int(),
  version: z.number().int(),
  createdAt: z.string(),
  updatedAt: z.string(),
})
export type Disposition = z.infer<typeof dispositionSchema>

export const dispositionsSchema = z.object({
  dispositions: z.array(dispositionSchema),
  outcomes: z.array(z.object({ outcome, words: z.string(), moves: z.array(move.nullable()), followUps: z.array(followUp.nullable()), reinspection: z.boolean() })),
  standardMissing: z.array(z.string()),
  canManage: z.boolean(),
})
export type Dispositions = z.infer<typeof dispositionsSchema>
export type OutcomeOption = Dispositions['outcomes'][number]

const seg = (value: string) => encodeURIComponent(value)

// ---- the defect library ------------------------------------------------------------------------------------------------

/** GET /quality/defects (quality.defects.view): the whole tree, retired codes too. */
export const readLibrary = (api: ApiClient, signal?: AbortSignal) => api.get('/quality/defects', { schema: librarySchema, signal })

export interface NewDefectBody {
  code: string
  parentId: string | null
  labelIt: string
  labelEn: string
  labelI18n?: Record<string, string>
  icon?: string | null
  colour?: string | null
  severity: 'CRITICAL' | 'MAJOR' | 'MINOR' | null
  zone: string | null
  stages: string[]
  needsDetail: boolean
}

export const createDefect = (api: ApiClient, body: NewDefectBody, idempotencyKey: string) =>
  api.post('/quality/defects', { body, schema: z.object({ defect: defectSchema }), idempotencyKey })

/** A change of one code: only the fields named (the version read always). */
export interface DefectEdit {
  labelIt?: string
  labelEn?: string
  labelI18n?: Record<string, string | null>
  icon?: string | null
  colour?: string | null
  pictureFileId?: string | null
  severity?: 'CRITICAL' | 'MAJOR' | 'MINOR' | null
  zone?: string | null
  stages?: string[]
  needsDetail?: boolean
  sortOrder?: number
  active?: boolean
}

export const editDefect = (api: ApiClient, id: string, version: number, edit: DefectEdit, idempotencyKey: string) =>
  api.request('PATCH', `/quality/defects/${seg(id)}`, { body: { version, ...edit }, schema: z.object({ defect: defectSchema, retireWords: z.string().nullable() }), idempotencyKey })

/** DELETE: only a code nothing names (no inspection defect, NCR or defect under it). */
export const deleteDefect = (api: ApiClient, id: string, version: number, idempotencyKey: string) =>
  api.request('DELETE', `/quality/defects/${seg(id)}`, { query: { version }, schema: z.object({ deleted: z.string(), code: z.string() }), idempotencyKey })

export const addStarter = (api: ApiClient, idempotencyKey: string) => api.post('/quality/defects/starter', { body: {}, schema: z.object({ added: z.array(z.string()) }), idempotencyKey })

// ---- the code's picture (files of record type DefectCode, kind PHOTO) ----------------------------------------------------

/**
 * A picture of a code: announce (POST /files, the code as its record; office only — a tenant-wide code names no site,
 * so the floor's tiles cannot read it yet) → the bytes to the store → complete → PATCH pictureFileId with the version.
 */
export async function uploadPicture(api: ApiClient, input: { companyId: string | null; defectId: string; version: number; file: Blob; name: string }) {
  const bytes = await input.file.arrayBuffer()
  const { file: stored, upload } = await requestUpload(api, {
    companyId: input.companyId,
    record: { type: 'DefectCode', id: input.defectId },
    kind: 'PHOTO',
    name: input.name,
    contentType: input.file.type || 'image/jpeg',
    sizeBytes: bytes.byteLength,
    sha256: await sha256Hex(bytes),
    visibility: ['OFFICE'],
    floorSiteId: null,
    partyId: null,
  })
  await putToStore(upload, bytes)
  await completeUpload(api, stored.id)
  return editDefect(api, input.defectId, input.version, { pictureFileId: stored.id }, newIdempotencyKey())
}

/** A picture's address for an <img> (the presigned GET lives 60 seconds; a same-origin path goes through this app's /api). */
export async function pictureAddress(api: ApiClient, fileId: string): Promise<string> {
  const answer = await api.get(`/files/${seg(fileId)}/download`, { schema: z.object({ download: presignedSchema }) })
  const url = answer.download.url
  return url.startsWith('/') && !url.startsWith('//') ? `/api${url}` : url
}

// ---- the disposition codes -----------------------------------------------------------------------------------------------

export const readDispositions = (api: ApiClient, signal?: AbortSignal) => api.get('/quality/dispositions', { schema: dispositionsSchema, signal })

export interface NewDispositionBody {
  code: string
  labelIt: string
  labelEn: string
  outcome: (typeof DISPOSITION_OUTCOMES)[number]
  stockMoveReason: (typeof DISPOSITION_MOVES)[number] | null
  followUp: (typeof DISPOSITION_FOLLOW_UPS)[number] | null
  reinspection: boolean
  approvalSeverity: 'CRITICAL' | 'MAJOR' | 'MINOR' | null
  approvalAmount?: number | null
}

export const createDisposition = (api: ApiClient, body: NewDispositionBody, idempotencyKey: string) =>
  api.post('/quality/dispositions', { body, schema: z.object({ disposition: dispositionSchema }), idempotencyKey })

/** A change of one code: never its code, outcome, move or follow-up (decisions keep them). */
export interface DispositionEdit {
  labelIt?: string
  labelEn?: string
  reinspection?: boolean
  approvalSeverity?: 'CRITICAL' | 'MAJOR' | 'MINOR' | null
  approvalAmount?: number | null
  sortOrder?: number
  active?: boolean
}

export const editDisposition = (api: ApiClient, id: string, version: number, edit: DispositionEdit, idempotencyKey: string) =>
  api.request('PATCH', `/quality/dispositions/${seg(id)}`, { body: { version, ...edit }, schema: z.object({ disposition: dispositionSchema }), idempotencyKey })

export const addStandardDispositions = (api: ApiClient, idempotencyKey: string) =>
  api.post('/quality/dispositions/standard', { body: {}, schema: z.object({ added: z.array(z.string()) }), idempotencyKey })
