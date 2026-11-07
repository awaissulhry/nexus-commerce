import type { GatewayCall } from '../../gateway/gateway'
import type { PresignedRequest } from '../port'

/**
 * Large uploads in parts (COL-052; B-W2b-160): what an object store does for a multipart upload, beside the file store
 * port (../port.ts). Both adapters implement it: `adapters/r2` (R2's S3 multipart API: CreateMultipartUpload, a
 * presigned UploadPart per part with its SHA-256 signed, ListParts, CompleteMultipartUpload, AbortMultipartUpload) and
 * `adapters/local-files` (FAKE: the parts as files in a folder of their own, joined at the end). Each operation runs inside
 * ONE gateway call (multipart/store.ts), like every store call.
 *
 * The parts are sent by the browser straight to the store; the store, not the browser, says which parts it took (ListParts),
 * so a resume after a dropped line asks only for the missing ones. A joined object's checksum is the store's checksum of
 * the parts, not the file's SHA-256, so the API reads the joined object once (`digest`, streamed) to check it against the
 * SHA-256 announced up front.
 */

export interface PartTarget {
  readonly key: string
  readonly uploadId: string
  readonly partNumber: number
  readonly sizeBytes: number
  /** Lower-case hex SHA-256 of the part: the store refuses a part with other bytes. */
  readonly sha256: string
  readonly expiresInSeconds: number
  readonly now: Date
}

/** A part the store holds. */
export interface StoredPart {
  readonly partNumber: number
  readonly etag: string
  readonly sizeBytes: number
  /** Lower-case hex SHA-256 of the part, when the store keeps it. */
  readonly sha256: string | null
}

/** The joined object as read back: its size, type and the SHA-256 of all its bytes. */
export interface ObjectDigest {
  readonly sizeBytes: number
  readonly contentType: string | null
  readonly sha256: string
}

export interface MultipartStoreAdapter {
  /** Starts a multipart upload under the key; returns the store's upload id. */
  startMultipart(call: GatewayCall, target: { readonly key: string; readonly contentType: string }): Promise<string>
  /** A presigned PUT for one part (its size and SHA-256 signed). */
  presignPart(call: GatewayCall, target: PartTarget): Promise<PresignedRequest>
  /** The parts the store holds, by number; null when the store has no such upload (completed, aborted or expired). */
  listParts(call: GatewayCall, key: string, uploadId: string): Promise<StoredPart[] | null>
  /** Joins the parts, in number order, into the object under the key. */
  completeMultipart(call: GatewayCall, key: string, uploadId: string, parts: readonly StoredPart[]): Promise<void>
  /** Gives the upload up and frees its parts; no such upload is not an error. */
  abortMultipart(call: GatewayCall, key: string, uploadId: string): Promise<void>
  /** Reads the object once, streamed, for its SHA-256; null when there is no object under the key. */
  digest(call: GatewayCall, key: string): Promise<ObjectDigest | null>
}

export const isMultipartAdapter = (adapter: object): adapter is MultipartStoreAdapter =>
  typeof (adapter as Partial<MultipartStoreAdapter>).startMultipart === 'function' && typeof (adapter as Partial<MultipartStoreAdapter>).digest === 'function'
