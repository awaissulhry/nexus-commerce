import { z } from 'zod'
import type { ApiClient } from '../../lib/api/client'
import { newIdempotencyKey } from '../../lib/api/client'
import { presignedSchema, type Presigned } from '../../record-panels/api'
import { StoreError, storeHeaders, storeUrl } from '../../record-panels/store'

/**
 * A shipment's documents by link (apps/factory-api modules/shipping/documents, B-W1-49; DOCUMENT_VIEW on a Shipment;
 * LOG-020, PPE Reg. art. 8(8)): what the party's link shows — the shipment, the link's own expiry and opens left, and
 * EXACTLY the files the office shared with the party's links (the DDT's copy, the Declaration of Conformity and the
 * user information per style revision and language). Reading uses nothing (only `POST /link/open`, which the landing
 * did, counts an open). A download is logged (an audit row on the file) and presigned for 60 s. "Ask for a new link"
 * is public and answers the same whatever the token. The token travels only in `x-factory-link` (the client the link
 * landing made); it is never in an address or in storage.
 */

export const LINK_DOCUMENT_KINDS = ['DDT', 'DECLARATION_OF_CONFORMITY', 'USER_INFORMATION', 'OTHER'] as const
export type LinkDocumentKind = (typeof LINK_DOCUMENT_KINDS)[number]

export const SHIPMENT_STATUSES = ['DRAFT', 'PACKED', 'SHIPPED', 'DELIVERED', 'RETURNED', 'CANCELLED'] as const

export const linkDocumentSchema = z.object({
  fileId: z.string(),
  /** A kind this page does not know yet reads as OTHER (its file name is its title). */
  kind: z.enum(LINK_DOCUMENT_KINDS).catch('OTHER'),
  /** The API's title (English): the page says its own words from the kind, the style and the number. */
  title: z.string(),
  style: z.object({ code: z.string(), name: z.string(), revision: z.number().nullable() }).nullable(),
  language: z.string().nullable(),
  number: z.string().nullable(),
  date: z.string().nullable(),
  originalName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number(),
  sha256: z.string(),
  availableAt: z.string(),
})
export type LinkDocument = z.infer<typeof linkDocumentSchema>

export const linkDocumentsSchema = z.object({
  shipment: z.object({ number: z.string(), status: z.string(), shippedAt: z.string().nullable(), deliveredAt: z.string().nullable() }),
  link: z.object({ expiresAt: z.string(), usesLeft: z.number() }),
  documents: z.array(linkDocumentSchema),
})
export type LinkDocuments = z.infer<typeof linkDocumentsSchema>

/** The shipment's documents the link shows (`GET /shipping/link/documents`). */
export function readLinkDocuments(api: ApiClient, signal?: AbortSignal): Promise<LinkDocuments> {
  return api.get('/shipping/link/documents', { schema: linkDocumentsSchema, signal })
}

const downloadSchema = z.object({ download: presignedSchema })

/**
 * One of the link's files: the API logs the download (an audit row on the file, under `idempotencyKey`: the same key
 * is answered from its receipt, so one visit reading the same file again logs it once), then presigns it for 60 s.
 */
export async function downloadLinkDocument(api: ApiClient, fileId: string, idempotencyKey: string): Promise<Presigned> {
  const answer = await api.post(`/shipping/link/documents/${encodeURIComponent(fileId)}/download`, { body: {}, schema: downloadSchema, idempotencyKey })
  return answer.download
}

/** The bytes behind a presigned GET (the store's request, not an API call: no token, no cookie of the API). */
export async function presignedBytes(download: Presigned, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await fetch(storeUrl(download.url), { method: download.method, headers: storeHeaders(download), credentials: 'omit', cache: 'no-store', signal })
  if (!response.ok) throw new StoreError(response.status)
  return new Uint8Array(await response.arrayBuffer())
}

const renewSchema = z.object({ status: z.literal('requested'), message: z.string() })

/**
 * "Ask for a new link" (`POST /shipping/link/renew`, public, the same `x-factory-link` header): always 202 with one
 * answer whatever the token; a new link goes only to the address the old one was sent to (never one typed here).
 */
export function askForNewLink(api: ApiClient): Promise<z.infer<typeof renewSchema>> {
  return api.post('/shipping/link/renew', { body: {}, schema: renewSchema, idempotencyKey: newIdempotencyKey() })
}
