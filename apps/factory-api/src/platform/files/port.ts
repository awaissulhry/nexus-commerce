import type { GatewayCall } from '../gateway/gateway'

/**
 * The file store port (plan A1 §4 "FileStore"): what an object store does for the files platform. Two adapters
 * implement it, chosen by the R2 account's mode: `adapters/r2` (LIVE, SANDBOX: Cloudflare R2 through the S3 API) and
 * `adapters/local-files` (FAKE: a folder on this machine, local and test only). Each operation runs inside ONE gateway
 * call (store.ts): the account is re-read, the call is rate limited and recorded as one IntegrationCall row, and the
 * adapter gets the account's settings and credentials from `call`. A presign signs locally and sends nothing.
 */

/** A request the browser (or a test) makes straight to the store: a presigned URL and the headers it must send. */
export interface PresignedRequest {
  readonly method: 'PUT' | 'GET'
  /** Absolute for R2; a path on this API (`/local-files?token=…`) for the local store. */
  readonly url: string
  /** Headers the request must carry exactly as given (they are signed). */
  readonly headers: Readonly<Record<string, string>>
  readonly expiresAt: Date
}

/** What the store says about a stored object (its HEAD). */
export interface StoredObject {
  readonly sizeBytes: number
  readonly contentType: string | null
  /** SHA-256 of the stored bytes, lower-case hex; null when the store did not say. */
  readonly sha256: string | null
}

export interface UploadTarget {
  readonly key: string
  readonly contentType: string
  readonly sizeBytes: number
  /** Lower-case hex. The store refuses a body with another checksum. */
  readonly sha256: string
  readonly expiresInSeconds: number
  readonly now: Date
}

export interface DownloadTarget {
  readonly key: string
  readonly contentType: string
  /** The `Content-Disposition` the download is served with (always an attachment). */
  readonly disposition: string
  readonly expiresInSeconds: number
  readonly now: Date
}

export interface FileStoreAdapter {
  presignUpload(call: GatewayCall, target: UploadTarget): Promise<PresignedRequest>
  presignDownload(call: GatewayCall, target: DownloadTarget): Promise<PresignedRequest>
  /** The object, or null when there is none under the key. */
  head(call: GatewayCall, key: string): Promise<StoredObject | null>
  /** Removes the object; no object under the key is not an error. */
  remove(call: GatewayCall, key: string): Promise<void>
}
