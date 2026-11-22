import { z } from 'zod'
import type { ApiClient } from '../../../lib/api/client'
import { completeUpload, presignedSchema } from '../../../record-panels/api'
import type { FileAudience } from '../../../record-panels/model'
import { putToStore, sha256Hex } from '../../../record-panels/store'
import { contentTypeOf } from '../../../lib/record-thread/attachments/model'

/**
 * F-OF-303 (order FILES tab W3; 13-backend B-OF-010, B-OF-011, S3) — the acts on one file the new windows send, through the ONE client, at
 * the file's version with the caller's Idempotency-Key: delete a WHOLE document (every version, with a reason: D4), rename (the current
 * version copied as the next one with the new name), who can see it (the existing visibility command: share with THIS record's customer,
 * or take it back — the floor or a link it has stays), and a new version (announce, PUT to the store, confirm: the audience and the price
 * mark carry over). The API checks the record, the right and the state again; a refusal comes back in its words.
 */

const enc = encodeURIComponent
const key = () => globalThis.crypto.randomUUID()
const anyAnswer = z.object({}).passthrough()

/** POST /files/:fileId/delete-document { version, reason } (files.delete): every version of the document, or none (a hold refuses all). */
export const deleteDocument = (api: ApiClient, fileId: string, body: { readonly version: number; readonly reason: string }) => api.post(`/files/${enc(fileId)}/delete-document`, { body, schema: anyAnswer, idempotencyKey: key() })

/** POST /files/:fileId/rename { version, name } (files.upload): a new version with the new name; the old name stays in the old one. */
export const renameFile = (api: ApiClient, fileId: string, body: { readonly version: number; readonly name: string }) => api.post(`/files/${enc(fileId)}/rename`, { body, schema: anyAnswer, idempotencyKey: key() })

/** PUT /files/:fileId/visibility (files.manage): who sees it now; a partner or a link names THIS record's customer. */
export const setVisibility = (api: ApiClient, file: { readonly id: string; readonly version: number }, visibility: readonly FileAudience[], partyId: string | null) =>
  api.request('PUT', `/files/${enc(file.id)}/visibility`, { body: { visibility: [...visibility], partyId: visibility.includes('PARTNER') || visibility.includes('LINK') ? partyId : null, version: file.version }, schema: anyAnswer, idempotencyKey: key() })

const announced = z.object({ file: z.object({ id: z.string() }), upload: presignedSchema })

/** POST /files/:fileId/versions (files.upload), the bytes to the store, then confirmed: the next version of the document. */
export async function addVersion(api: ApiClient, fileId: string, file: File, name: string): Promise<{ readonly id: string; readonly status: string }> {
  const bytes = await file.arrayBuffer()
  const contentType = contentTypeOf(file)
  const made = await api.post(`/files/${enc(fileId)}/versions`, { body: { originalName: name, contentType, sizeBytes: bytes.byteLength, sha256: await sha256Hex(bytes) }, schema: announced, idempotencyKey: key() })
  await putToStore(made.upload, new Blob([bytes], { type: contentType }))
  const done = await completeUpload(api, made.file.id)
  return { id: done.file.id, status: done.file.status }
}
