import { z } from 'zod'
import { DUPLICATE_REASONS, DUPLICATE_RECORD_TYPES, LIKELIHOODS, MERGE_REFUSALS, USE_GROUPS, type DuplicateRecordType } from '@nexus/factory-domain/imports/duplicates/rules'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'

/**
 * Likely duplicates' calls (B-W2b-427; PLT-178; apps/factory-api platform/imports/duplicates): the check on create
 * (parties, materials), an import's possible duplicates, the list of them, the merge preview and the merge. Each answer
 * is checked against its shape (a mirror of platform/imports/duplicates/contract.ts, named per schema); the codes come
 * from factory-domain imports/duplicates/rules.
 */

/** contract.ts reasonView. */
export const reasonSchema = z.object({ code: z.enum(DUPLICATE_REASONS), detail: z.string().nullable(), score: z.number().nullable() })
export type DuplicateReasonFound = z.infer<typeof reasonSchema>

/** contract.ts candidateView. */
export const candidateSchema = z.object({
  recordType: z.enum(DUPLICATE_RECORD_TYPES),
  id: z.string(),
  code: z.string(),
  name: z.string(),
  status: z.string(),
  companyId: z.string().nullable(),
  roles: z.array(z.string()),
  kind: z.string().nullable(),
  likelihood: z.enum(LIKELIHOODS),
  reasons: z.array(reasonSchema),
})
export type DuplicateCandidate = z.infer<typeof candidateSchema>

const candidates = z.object({ candidates: z.array(candidateSchema) })

/** contract.ts pairView. */
const sideSchema = candidateSchema.omit({ likelihood: true, reasons: true }).extend({ createdAt: z.string() })
export const pairSchema = z.object({ key: z.string(), a: sideSchema, b: sideSchema, likelihood: z.enum(LIKELIHOODS), reasons: z.array(reasonSchema) })
export type DuplicatePair = z.infer<typeof pairSchema>
export const scanSchema = z.object({ recordType: z.enum(DUPLICATE_RECORD_TYPES), pairs: z.array(pairSchema), more: z.boolean(), compared: z.number() })
export type DuplicateScan = z.infer<typeof scanSchema>

/** contract.ts mergePreviewView. */
const mergeSideSchema = z.object({ id: z.string(), code: z.string(), name: z.string(), status: z.string(), companyId: z.string().nullable(), version: z.number(), kind: z.string().nullable(), roles: z.array(z.string()) })
export type MergeSide = z.infer<typeof mergeSideSchema>
const counts = z.object({ contacts: z.number(), addresses: z.number(), taxIdentities: z.number(), colours: z.number() })
export const mergePreviewSchema = z.object({
  recordType: z.enum(DUPLICATE_RECORD_TYPES),
  kept: mergeSideSchema,
  dropped: mergeSideSchema,
  refusals: z.array(z.enum(MERGE_REFUSALS)),
  uses: z.array(z.object({ group: z.enum(USE_GROUPS), count: z.number(), tables: z.array(z.string()) })),
  moves: counts,
  stays: counts,
  reverseWorks: z.boolean(),
})
export type MergePreview = z.infer<typeof mergePreviewSchema>
export const mergeAnswerSchema = z.object({ recordType: z.enum(DUPLICATE_RECORD_TYPES), kept: mergeSideSchema, dropped: mergeSideSchema, moved: counts })
export type MergeAnswer = z.infer<typeof mergeAnswerSchema>

/** contract.ts importRowView and the answer of GET /imports/:importId/duplicates. */
export const importRowSchema = z.object({
  rowNumber: z.number(),
  key: z.string().nullable(),
  name: z.string().nullable(),
  recordId: z.string().nullable(),
  candidates: z.array(candidateSchema),
  sameSheet: z.array(z.object({ rowNumber: z.number(), key: z.string().nullable(), recordId: z.string().nullable(), likelihood: z.enum(LIKELIHOODS), reasons: z.array(reasonSchema) })),
})
export type ImportDuplicateRow = z.infer<typeof importRowSchema>
export const importDuplicatesSchema = z.object({
  jobId: z.string(),
  importerKey: z.string(),
  supported: z.boolean(),
  recordType: z.enum(DUPLICATE_RECORD_TYPES).nullable(),
  checked: z.number(),
  more: z.boolean(),
  rows: z.array(importRowSchema),
})
export type ImportDuplicates = z.infer<typeof importDuplicatesSchema>

/** What a new party is checked by (New customer, New supplier). */
export interface PartyCheck {
  readonly legalName?: string | null
  readonly tradeName?: string | null
  readonly country?: string | null
  readonly vatNumber?: string | null
  readonly fiscalCode?: string | null
}

/** What a new material is checked by (New material). */
export interface MaterialCheck {
  readonly code?: string | null
  readonly name?: string | null
  readonly supplierId?: string | null
  readonly supplierArticleCode?: string | null
}

const blankless = <T extends object>(body: T): T => Object.fromEntries(Object.entries(body).filter(([, value]) => value !== null && value !== undefined && value !== '')) as T

export const checkParty = (api: ApiClient, body: PartyCheck, signal?: AbortSignal) =>
  api.post('/duplicates/parties/check', { body: blankless({ ...body }), schema: candidates, signal }).then((answer) => answer.candidates)

export const checkMaterial = (api: ApiClient, body: MaterialCheck, signal?: AbortSignal) =>
  api.post('/duplicates/materials/check', { body: blankless({ ...body }), schema: candidates, signal }).then((answer) => answer.candidates)

const LIST_PATH: Readonly<Record<DuplicateRecordType, string>> = { PARTY: '/duplicates/parties', MATERIAL: '/duplicates/materials' }

export const scanDuplicates = (api: ApiClient, recordType: DuplicateRecordType, companyId?: string | null) =>
  api.get(LIST_PATH[recordType], { query: { companyId: companyId ?? undefined }, schema: scanSchema })

export const importDuplicates = (api: ApiClient, importId: string) => api.get(`/imports/${encodeURIComponent(importId)}/duplicates`, { schema: importDuplicatesSchema })

export const previewMerge = (api: ApiClient, recordType: DuplicateRecordType, keptId: string, droppedId: string) =>
  api.get(`/duplicates/${recordType}/merge`, { query: { keptId, droppedId }, schema: mergePreviewSchema })

export const mergeRecords = (api: ApiClient, recordType: DuplicateRecordType, body: { keptId: string; droppedId: string; keptVersion: number; droppedVersion: number; reason: string }) =>
  api.post(`/duplicates/${recordType}/merge`, { body, schema: mergeAnswerSchema, idempotencyKey: newIdempotencyKey() })
