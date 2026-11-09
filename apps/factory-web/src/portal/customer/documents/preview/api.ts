import { z } from 'zod'
import { newIdempotencyKey, type ApiClient } from '../../../../lib/api/client'
import { readFromStore } from '../../../../record-panels/store'

/**
 * One document of the customer's library and how it is opened (B-W2b-178's API; lifted from Home by B-W2b-195 so Home's New
 * documents, the Documents page and the order's Documents tab read and open a document the same way). Each answer is
 * checked; the web reads only what it uses. An invoice's amount comes only with the person's price grain (optional here).
 */

const words = z.object({ it: z.string(), en: z.string() })
const replacementSchema = z.object({ id: z.string().nullable(), title: words, version: z.number() })

export const DOCUMENT_FORMATS = ['PDF', 'XML', 'FILE'] as const
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number]

export const documentFileSchema = z.object({ fileId: z.string(), format: z.enum(DOCUMENT_FORMATS).catch('FILE'), name: z.string(), contentType: z.string(), sizeBytes: z.number() })
export type DocumentFile = z.infer<typeof documentFileSchema>

export const documentSchema = z.object({
  id: z.string(),
  kind: z.string(),
  kindWords: words,
  group: z.string(),
  title: words,
  for: z
    .object({ type: z.string(), id: z.string(), label: z.string().nullable(), order: z.object({ id: z.string(), number: z.string(), customerRef: z.string().nullable() }).nullable() })
    .nullable(),
  style: z.object({ code: z.string(), name: z.string() }).nullable().optional(),
  date: z.string(),
  version: z.number(),
  sha256: z.string().optional(),
  fingerprint: z.string(),
  language: z.string().nullable(),
  current: z.boolean(),
  replacedBy: replacementSchema.nullable(),
  new: z.boolean(),
  expiresOn: z.string().nullable().optional(),
  files: z.array(documentFileSchema),
  // Price grain only (the API drops them otherwise).
  grossTotal: z.number().nullable().optional(),
  currency: z.string().nullable().optional(),
})
export type CustomerDocument = z.infer<typeof documentSchema>

export const oneDocumentSchema = z.object({
  document: documentSchema.nullable(),
  withdrawn: z.object({ title: words, version: z.number(), replacedBy: replacementSchema.nullable() }).nullable(),
  versions: z.array(documentSchema),
})
export type OneDocument = z.infer<typeof oneDocumentSchema>

/** The document and every version of it the person sees (newest first); a withdrawn one names the newer. */
export const fetchDocument = (api: ApiClient, fileId: string, signal?: AbortSignal): Promise<OneDocument> =>
  api.get(`/portal/customer-documents/${encodeURIComponent(fileId)}`, { schema: oneDocumentSchema, signal })

const downloadSchema = z.object({
  document: z.object({ id: z.string(), title: words, version: z.number(), format: z.enum(DOCUMENT_FORMATS).catch('FILE'), name: z.string() }),
  download: z.object({ mode: z.enum(['inline', 'download']), method: z.literal('GET'), url: z.string(), headers: z.record(z.string(), z.string()), expiresAt: z.string() }),
})

/**
 * A document's bytes (ONE logged open: POST …/download, the API writes the audit row, then the 60-second address is read
 * at once). `preview` opens in place; `download` is saved. The open clears NEW for this person. `fileId` is any file of
 * the document (an invoice's PDF or its XML).
 */
export async function documentBytes(api: ApiClient, fileId: string, mode: 'preview' | 'download'): Promise<{ name: string; bytes: Uint8Array }> {
  const answer = await api.post(`/portal/customer-documents/${encodeURIComponent(fileId)}/download`, { body: { mode }, schema: downloadSchema, idempotencyKey: newIdempotencyKey() })
  const bytes = await readFromStore({ method: 'GET', url: answer.download.url, headers: answer.download.headers, expiresAt: answer.download.expiresAt })
  return { name: answer.document.name, bytes }
}
