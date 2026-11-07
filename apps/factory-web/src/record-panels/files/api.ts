import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../lib/api/client'
import { fileSchema, presignedSchema, type RecordKey } from '../api'

/**
 * The files panel's depth calls (B-W2b-177 on apps/factory-api platform/files/{required,markup}, B-W2b-160's versions):
 * a record's documents and what each status move still needs, what a file is and until when, the Versions pop-up's
 * history, restore, the 60-second preview, and markup. Each answer is checked against what the panel reads.
 */

export const REQUIREMENT_REASONS = ['MET', 'MISSING', 'EXPIRED'] as const
export const EXPIRY_STATES = ['NONE', 'VALID', 'EXPIRING', 'EXPIRED'] as const

const documentSchema = z.object({
  fileId: z.string(),
  category: z.string().nullable(),
  expiresOn: z.string().nullable(),
  expiryState: z.enum(EXPIRY_STATES),
  daysLeft: z.number().int().nullable(),
  ofParty: z.boolean(),
  originalName: z.string(),
})
export type ApiDocument = z.infer<typeof documentSchema>

const requirementSchema = z.object({
  ruleId: z.string(),
  category: z.string(),
  partyRole: z.string().nullable(),
  level: z.enum(['BLOCK', 'WARN']),
  reason: z.enum(REQUIREMENT_REASONS),
  fileId: z.string().nullable(),
  expiresOn: z.string().nullable(),
})
export type ApiRequirement = z.infer<typeof requirementSchema>

const documentsSchema = z.object({
  status: z.string().nullable(),
  today: z.string(),
  documents: z.array(documentSchema),
  moves: z.array(z.object({ toStatus: z.string(), requirements: z.array(requirementSchema) })),
  mayTag: z.boolean(),
})
export type ApiDocuments = z.infer<typeof documentsSchema>

const historySchema = fileSchema.extend({
  versionNo: z.number().int().optional(),
  supersededAt: z.string().nullable().optional(),
  current: z.boolean(),
  addedBy: z.object({ id: z.string().nullable(), name: z.string().nullable(), fromPartner: z.boolean() }),
  madeByMarkup: z.object({ id: z.string(), note: z.string().nullable(), marks: z.number().int() }).nullable(),
  usedBy: z.array(z.object({ fileId: z.string(), recordType: z.string(), recordId: z.string(), label: z.string().nullable() })),
  markups: z.number().int(),
})
export type ApiHistoryVersion = z.infer<typeof historySchema>

const point = z.object({ x: z.number(), y: z.number() })
export const markSchema = z.union([z.object({ kind: z.literal('arrow'), from: point, to: point }), z.object({ kind: z.literal('circle'), center: point, radius: z.number() })])
const markupSchema = z.object({
  id: z.string(),
  fileId: z.string(),
  versionNo: z.number().int().nullable(),
  page: z.number().int().nullable(),
  shapes: z.array(markSchema),
  note: z.string().nullable(),
  resultFileId: z.string().nullable(),
  createdByName: z.string().nullable(),
  fromPartner: z.boolean(),
  createdAt: z.string(),
})
export type ApiMarkup = z.infer<typeof markupSchema>

/** GET /files/documents: the record's documents and each status move's needs. */
export function readDocuments(api: ApiClient, record: RecordKey, signal?: AbortSignal): Promise<ApiDocuments> {
  return api.get('/files/documents', { query: { recordType: record.type, recordId: record.id }, schema: documentsSchema, signal })
}

/** PUT /files/:id/document: what the file is and its last valid day, at the version read. */
export function saveDocument(api: ApiClient, fileId: string, body: { category?: string | null; expiresOn?: string | null; version: number }): Promise<{ version: number }> {
  return api.request('PUT', `/files/${encodeURIComponent(fileId)}/document`, { body, idempotencyKey: newIdempotencyKey(), schema: z.object({ version: z.number().int() }) })
}

/** GET /files/:id/history: the Versions pop-up's rows. */
export function readHistory(api: ApiClient, fileId: string, signal?: AbortSignal): Promise<{ versions: ApiHistoryVersion[] }> {
  return api.get(`/files/${encodeURIComponent(fileId)}/history`, { schema: z.object({ versions: z.array(historySchema) }), signal })
}

/** POST /files/:id/restore: an earlier version comes back as the next one. */
export function restoreVersion(api: ApiClient, fileId: string): Promise<unknown> {
  return api.post(`/files/${encodeURIComponent(fileId)}/restore`, { idempotencyKey: newIdempotencyKey() })
}

/** GET /files/:id/preview: a picture or a PDF to open (60 seconds), else a download. */
export function previewLink(api: ApiClient, fileId: string): Promise<{ preview: { mode: 'inline' | 'download'; url: string; headers: Record<string, string>; expiresAt: string; contentType?: string } }> {
  return api.get(`/files/${encodeURIComponent(fileId)}/preview`, {
    schema: z.object({ preview: z.object({ mode: z.enum(['inline', 'download']), url: z.string(), headers: z.record(z.string(), z.string()).default({}), expiresAt: z.string(), contentType: z.string().optional() }) }),
  })
}

/** GET /files/:id/markups: the markups of the file's series, newest first. */
export function readMarkups(api: ApiClient, fileId: string, signal?: AbortSignal): Promise<{ markups: ApiMarkup[] }> {
  return api.get(`/files/${encodeURIComponent(fileId)}/markups`, { schema: z.object({ markups: z.array(markupSchema) }), signal })
}

/** POST /files/:id/markups: a PDF page's overlay, or a picture's marked copy announced (then PUT to the store and confirmed). */
export function createMarkup(
  api: ApiClient,
  fileId: string,
  body: { page: number | null; shapes: readonly unknown[]; note: string | null; result: { contentType: string; sizeBytes: number; sha256: string } | null },
): Promise<{ markup: ApiMarkup; file: { id: string } | null; upload: z.infer<typeof presignedSchema> | null }> {
  return api.post(`/files/${encodeURIComponent(fileId)}/markups`, {
    body: { ...body, shapes: [...body.shapes] },
    idempotencyKey: newIdempotencyKey(),
    schema: z.object({ markup: markupSchema, file: z.object({ id: z.string() }).nullable(), upload: presignedSchema.nullable() }),
  })
}
