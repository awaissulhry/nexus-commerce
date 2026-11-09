import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { presignedSchema } from '../../../record-panels/api'

/**
 * Every call of the supplier's Documents page (B-W2b-193, SCR-190), each answer checked against the API's contract
 * (apps/factory-api modules/purchasing/portal-profile/contract.ts, B-W2b-189 / F13a): "We ask for" and "Your documents" in
 * one read, and the upload in three steps (announce → the store's presigned PUT → complete). A shared document's bytes come
 * through the files route (record-panels `downloadLink`: a presigned GET of 60 seconds; an upload not yet accepted is not
 * shared and answers 404). The API's sentences (`reason`) are English: the page says its own words from the codes.
 */

const recordRef = z.object({ type: z.string(), id: z.string(), label: z.string() })
export type RecordRef = z.infer<typeof recordRef>

export const ASK_SOURCES = ['RULE', 'EXPIRY', 'ASKED', 'REFUSED'] as const
export type AskSource = (typeof ASK_SOURCES)[number]

const askedRow = z.object({
  key: z.string(),
  source: z.enum(ASK_SOURCES),
  category: z.string().nullable(),
  record: recordRef,
  forRecords: z.array(recordRef),
  dueOn: z.string().nullable(),
  level: z.enum(['BLOCK', 'WARN']).nullable(),
  state: z.enum(['MISSING', 'EXPIRED']).nullable(),
  taskId: z.string().nullable(),
  askedBy: z.string().nullable(),
  /** A document of this kind for it waits for our check already. */
  waiting: z.boolean(),
})
export type AskedRow = z.infer<typeof askedRow>

export const DOCUMENT_STATES = ['NOT_RECEIVED', 'CHECKING', 'HELD', 'WAITING', 'ACCEPTED', 'EXPIRED', 'REJECTED'] as const
export type DocumentState = (typeof DOCUMENT_STATES)[number]

const documentRow = z.object({
  fileId: z.string(),
  uploadFileId: z.string().nullable(),
  state: z.enum(DOCUMENT_STATES),
  category: z.string().nullable(),
  name: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  record: recordRef,
  issuer: z.string().nullable(),
  number: z.string().nullable(),
  issuedOn: z.string().nullable(),
  expiresOn: z.string().nullable(),
  daysLeft: z.number().nullable(),
  articles: z.array(z.string()),
  lots: z.array(z.string()),
  sentAt: z.string().nullable(),
  decidedAt: z.string().nullable(),
  /** Our refusal's reason, as the reviewer typed it to the supplier. */
  reason: z.string().nullable(),
  canReplace: z.boolean(),
})
export type DocumentRow = z.infer<typeof documentRow>

export const supplierDocumentsSchema = z.object({
  today: z.string(),
  mayUpload: z.boolean(),
  categories: z.array(z.string()),
  requested: z.array(askedRow),
  documents: z.array(documentRow),
  counts: z.object({ requested: z.number(), waiting: z.number(), expiring: z.number(), refused: z.number() }),
  live: z.object({ events: z.array(z.string()) }),
})
export type SupplierDocuments = z.infer<typeof supplierDocumentsSchema>

export const fetchSupplierDocuments = (api: ApiClient, signal?: AbortSignal) => api.get('/portal/supplier-documents', { schema: supplierDocumentsSchema, signal })

export interface AnnounceBody {
  category: string
  issuer: string | null
  number: string | null
  issuedOn: string | null
  expiresOn: string | null
  articles: string[]
  lots: string[]
  note: string | null
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
  taskId?: string | null
  recordType?: string | null
  recordId?: string | null
  replacesFileId?: string | null
}

const announced = z.object({ file: z.object({ id: z.string(), status: z.string() }), record: recordRef, upload: presignedSchema })
export type Announced = z.infer<typeof announced>

/** Step 1: what the supplier says about the document; the answer carries the store's presigned PUT. One key per pop-up. */
export const announceDocument = (api: ApiClient, body: AnnounceBody, idempotencyKey: string) => api.post('/portal/supplier-documents', { body, schema: announced, idempotencyKey })

/** Step 3: the bytes arrived; the upload waits for our check (or is checked by the scanner first). */
export const completeDocument = (api: ApiClient, fileId: string, idempotencyKey: string) =>
  api.post(`/portal/supplier-documents/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: z.object({ file: z.object({ id: z.string(), status: z.string() }), state: z.enum(DOCUMENT_STATES) }), idempotencyKey })
