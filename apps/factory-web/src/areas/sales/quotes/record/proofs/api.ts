import { z } from 'zod'
import { QUOTE_VERSION_STATUSES } from '@nexus/factory-domain/sales/quotes/quotes'
import { newIdempotencyKey, type ApiClient } from '../../../../../lib/api/client'
import { presignedSchema, type Presigned } from '../../../../../record-panels/api'

/**
 * The quote's proofs (apps/factory-api modules/sales/quote-proofs; B-W2b-165; SAL-199): every call of the Documents tab's
 * Proofs panel. A proof's bytes never pass through the API: announced, PUT to the store with the presigned request, then
 * confirmed; opened through the files preview (a presigned GET for 60 s). The API's English (`held`, `frozen`) is not
 * shown: the panel says its own words from the version's state.
 */

const shape = z.enum(['PDF', 'PICTURE'])
const acceptedProof = z.object({ fileId: z.string(), name: z.string(), sha256: z.string(), versionNo: z.number(), sizeBytes: z.number(), contentType: z.string() })
const accepted = z.object({ acceptanceId: z.string().nullable(), signerName: z.string().nullable(), acceptedAt: z.string(), proofs: z.array(acceptedProof) })

export const proofSchema = z.object({
  fileId: z.string(),
  seriesId: z.string(),
  name: z.string(),
  contentType: z.string(),
  shape,
  sizeBytes: z.number(),
  sha256: z.string(),
  versionNo: z.number(),
  state: z.enum(['READY', 'UPLOADING', 'CHECKING', 'REFUSED']),
  currentFileId: z.string().nullable(),
  sharedWithCustomer: z.boolean(),
  sourceFileId: z.string().nullable(),
  addedAt: z.string(),
  addedBy: z.string().nullable(),
})
export type QuoteProof = z.infer<typeof proofSchema>

export const proofsSchema = z.object({
  quoteId: z.string(),
  versions: z.array(
    z.object({
      versionId: z.string(),
      revision: z.number(),
      status: z.enum(QUOTE_VERSION_STATUSES),
      current: z.boolean(),
      sentAt: z.string().nullable(),
      frozen: z.string().nullable(),
      proofs: z.array(proofSchema),
      accepted: accepted.nullable(),
    }),
  ),
  may: z.object({ change: z.boolean(), held: z.string().nullable() }),
  carry: z.object({ fromVersionId: z.string(), revision: z.number(), count: z.number() }).nullable(),
  limits: z.object({ max: z.number(), contentTypes: z.array(z.string()) }),
  at: z.string(),
})
export type QuoteProofs = z.infer<typeof proofsSchema>
export type ProofVersion = QuoteProofs['versions'][number]

const base = (quoteId: string) => `/sales/quotes/${encodeURIComponent(quoteId)}/proofs`

export function readProofs(api: ApiClient, quoteId: string, signal?: AbortSignal): Promise<QuoteProofs> {
  return api.get(base(quoteId), { schema: proofsSchema, signal })
}

export interface ProofAnnouncement {
  originalName: string
  contentType: string
  sizeBytes: number
  sha256: string
}

/** POST …/proofs (a new proof) or …/proofs/<file>/versions (its next version): the file and its presigned PUT. */
export function announceProof(api: ApiClient, quoteId: string, body: ProofAnnouncement, of?: string): Promise<{ file: { id: string }; upload: Presigned }> {
  return api.post(of ? `${base(quoteId)}/${encodeURIComponent(of)}/versions` : base(quoteId), { body, schema: z.object({ file: z.object({ id: z.string() }), upload: presignedSchema }), idempotencyKey: newIdempotencyKey() })
}

export function completeProof(api: ApiClient, quoteId: string, fileId: string): Promise<QuoteProofs> {
  return api.post(`${base(quoteId)}/${encodeURIComponent(fileId)}/complete`, { body: {}, schema: proofsSchema, idempotencyKey: newIdempotencyKey() })
}

export function removeProof(api: ApiClient, quoteId: string, fileId: string): Promise<QuoteProofs> {
  return api.request('DELETE', `${base(quoteId)}/${encodeURIComponent(fileId)}`, { schema: proofsSchema, idempotencyKey: newIdempotencyKey() })
}

export function carryProofs(api: ApiClient, quoteId: string, fromVersionId: string): Promise<QuoteProofs> {
  return api.post(`${base(quoteId)}/carry`, { body: { fromVersionId }, schema: proofsSchema, idempotencyKey: newIdempotencyKey() })
}

/** GET /files/<id>/preview: a presigned GET for 60 s, inline for a PDF or a picture (B-W2b-160). */
export function previewProof(api: ApiClient, fileId: string): Promise<{ preview: Presigned }> {
  return api.get(`/files/${encodeURIComponent(fileId)}/preview`, { schema: z.object({ preview: presignedSchema.extend({ mode: z.enum(['inline', 'download']) }) }) })
}
