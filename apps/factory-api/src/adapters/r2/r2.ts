import { DeleteObjectCommand, GetObjectCommand, HeadObjectCommand, PutObjectCommand, S3Client, S3ServiceException, type S3ClientConfig } from '@aws-sdk/client-s3'
// B-W2b-160 (COL-052): large uploads in parts.
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, ListPartsCommand, UploadPartCommand } from '@aws-sdk/client-s3'
import { createHash } from 'node:crypto'
import type { MultipartStoreAdapter, ObjectDigest, PartTarget, StoredPart } from '../../platform/files/multipart/port'
import { getSignedUrl } from '@aws-sdk/s3-request-presigner'
import { z } from 'zod'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { TooLargeObjectError, type DownloadTarget, type FileStoreAdapter, type PresignedRequest, type PutTarget, type StoredObject, type UploadTarget } from '../../platform/files/port'
import { isLegalKey } from '../../platform/files/rules'

/**
 * Cloudflare R2 through its S3 API (plan A1 §3.6, §4 "FileStore"; feature PLT-011: an EU-jurisdiction bucket), the
 * store of an R2 account in LIVE or SANDBOX mode. Every operation runs inside a gateway call (platform/files/store.ts),
 * which supplies the account's settings and sealed credentials and records the call; nothing here reads the
 * environment.
 *
 *   settings      { endpoint: "https://<account>.eu.r2.cloudflarestorage.com", bucket, legalBucket? } — keys under
 *                 `legal/` (the fiscal archive) go to legalBucket, the bucket with the 10-year lock rule (A1 §3.6)
 *   credentials   { accessKeyId, secretAccessKey } — an R2 API token limited to these buckets
 *
 *   presign PUT   content type, length and `x-amz-checksum-sha256` are signed headers: R2 refuses another type or
 *                 size, and a body whose SHA-256 differs; it lives `expiresInSeconds` (5 minutes)
 *   presign GET   `response-content-disposition: attachment…` and the stored type; 60 seconds
 *   head          size, type and the stored SHA-256 checksum (`x-amz-checksum-mode: ENABLED`); 404 → null
 *   put           PutObject of bytes the API made (a generated document), with its SHA-256: R2 refuses another body
 *   delete        DeleteObject; the retention check is the caller's (store.ts), the legal bucket's lock is R2's
 *   read          GetObject (server-side work on a file, an import's sheet); 404 → null; a body larger than the
 *                 reader allows is refused from its length before it is read
 *
 * Presigning signs locally and sends nothing. The client makes one attempt per call (the gateway retries) and gets the
 * gateway's abort signal. Tests give `clientFor` an S3Client with a fake request handler: no network.
 *
 * B-W2b-160 (COL-052), large uploads in parts (platform/files/multipart/port.ts):
 *   start         CreateMultipartUpload with the type and SHA-256 part checksums (ChecksumAlgorithm SHA256)
 *   presign part  UploadPart: its length and `x-amz-checksum-sha256` signed, so R2 refuses a part with other bytes
 *   list parts    ListParts (every page): number, ETag, size and checksum of each part R2 holds; NoSuchUpload → null
 *   complete      CompleteMultipartUpload with each part's ETag and checksum, in number order
 *   abort         AbortMultipartUpload; NoSuchUpload is not an error
 *   digest        GetObject streamed through SHA-256 (the joined object's own checksum is the parts', not the file's)
 */

const settingsSchema = z.object({
  endpoint: z.url({ protocol: /^https$/ }),
  bucket: z.string().min(3).max(63),
  legalBucket: z.string().min(3).max(63).optional(),
})
const credentialsSchema = z.object({ accessKeyId: z.string().min(1), secretAccessKey: z.string().min(1) })

export interface R2Options {
  /** Makes the client for one call (tests: a fake request handler). Default `new S3Client(config)`. */
  readonly clientFor?: (config: S3ClientConfig) => S3Client
}

const hexToBase64 = (hex: string): string => Buffer.from(hex, 'hex').toString('base64')
const base64ToHex = (value: string): string => Buffer.from(value, 'base64').toString('hex')

/** An S3 error answer as the gateway's ProviderError (a 4xx is final, a 5xx or 429 retryable); other errors pass on. */
function asProviderError(error: unknown, operation: string): never {
  if (error instanceof S3ServiceException) {
    const httpStatus = error.$metadata?.httpStatusCode
    throw new ProviderError(`R2 ${operation}: ${error.name}`, httpStatus === undefined ? {} : { httpStatus })
  }
  throw error
}

export function r2FileStore(options: R2Options = {}): FileStoreAdapter & MultipartStoreAdapter {
  const clientFor = options.clientFor ?? ((config: S3ClientConfig) => new S3Client(config))

  async function open(call: GatewayCall): Promise<{ client: S3Client; bucketOf: (key: string) => string }> {
    if (call.account.mode === 'FAKE') throw new ProviderError('A FAKE account uses the local file store, not R2.', { retryable: false })
    const settings = settingsSchema.safeParse(call.account.settings)
    if (!settings.success) throw new ProviderError('The R2 account settings need an https endpoint and a bucket.', { retryable: false })
    const credentials = credentialsSchema.safeParse(await call.credentials())
    if (!credentials.success) throw new ProviderError('The R2 account has no access key.', { retryable: false })
    const client = clientFor({
      region: 'auto',
      endpoint: settings.data.endpoint,
      forcePathStyle: true,
      credentials: credentials.data,
      maxAttempts: 1,
      // Only the checksums we ask for: the SDK's default CRC32 would sign an empty body's checksum into a presigned PUT.
      requestChecksumCalculation: 'WHEN_REQUIRED',
      responseChecksumValidation: 'WHEN_REQUIRED',
    })
    const { bucket, legalBucket } = settings.data
    return { client, bucketOf: (key) => (isLegalKey(key) ? (legalBucket ?? bucket) : bucket) }
  }

  return {
    async presignUpload(call: GatewayCall, target: UploadTarget): Promise<PresignedRequest> {
      const { client, bucketOf } = await open(call)
      const checksum = hexToBase64(target.sha256)
      const url = await getSignedUrl(
        client,
        new PutObjectCommand({ Bucket: bucketOf(target.key), Key: target.key, ContentType: target.contentType, ContentLength: target.sizeBytes, ChecksumSHA256: checksum }),
        {
          expiresIn: target.expiresInSeconds,
          signingDate: target.now,
          signableHeaders: new Set(['content-type', 'content-length', 'x-amz-checksum-sha256']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      )
      return {
        method: 'PUT',
        url,
        // content-length is signed too; the browser sets it from the body.
        headers: { 'content-type': target.contentType, 'x-amz-checksum-sha256': checksum },
        expiresAt: new Date(target.now.getTime() + target.expiresInSeconds * 1000),
      }
    },

    async presignDownload(call: GatewayCall, target: DownloadTarget): Promise<PresignedRequest> {
      const { client, bucketOf } = await open(call)
      const url = await getSignedUrl(
        client,
        new GetObjectCommand({ Bucket: bucketOf(target.key), Key: target.key, ResponseContentDisposition: target.disposition, ResponseContentType: target.contentType }),
        { expiresIn: target.expiresInSeconds, signingDate: target.now },
      )
      return { method: 'GET', url, headers: {}, expiresAt: new Date(target.now.getTime() + target.expiresInSeconds * 1000) }
    },

    async head(call: GatewayCall, key: string): Promise<StoredObject | null> {
      const { client, bucketOf } = await open(call)
      try {
        const found = await client.send(new HeadObjectCommand({ Bucket: bucketOf(key), Key: key, ChecksumMode: 'ENABLED' }), { abortSignal: call.signal })
        call.answer({ httpStatus: 200, response: { sizeBytes: found.ContentLength ?? null, contentType: found.ContentType ?? null } })
        return {
          sizeBytes: found.ContentLength ?? -1,
          contentType: found.ContentType ?? null,
          sha256: found.ChecksumSHA256 ? base64ToHex(found.ChecksumSHA256) : null,
        }
      } catch (error) {
        if (error instanceof S3ServiceException && error.$metadata?.httpStatusCode === 404) {
          call.answer({ httpStatus: 404, response: { found: false } })
          return null
        }
        return asProviderError(error, 'HeadObject')
      }
    },

    async put(call: GatewayCall, target: PutTarget): Promise<void> {
      const { client, bucketOf } = await open(call)
      try {
        await client.send(
          new PutObjectCommand({
            Bucket: bucketOf(target.key),
            Key: target.key,
            Body: target.body,
            ContentType: target.contentType,
            ContentLength: target.body.byteLength,
            ChecksumSHA256: hexToBase64(target.sha256),
          }),
          { abortSignal: call.signal },
        )
        call.answer({ httpStatus: 200 })
      } catch (error) {
        asProviderError(error, 'PutObject')
      }
    },

    async remove(call: GatewayCall, key: string): Promise<void> {
      const { client, bucketOf } = await open(call)
      try {
        await client.send(new DeleteObjectCommand({ Bucket: bucketOf(key), Key: key }), { abortSignal: call.signal })
        call.answer({ httpStatus: 204 })
      } catch (error) {
        asProviderError(error, 'DeleteObject')
      }
    },

    async read(call: GatewayCall, key: string, maxBytes: number): Promise<Buffer | null> {
      const { client, bucketOf } = await open(call)
      let found
      try {
        found = await client.send(new GetObjectCommand({ Bucket: bucketOf(key), Key: key }), { abortSignal: call.signal })
      } catch (error) {
        if (error instanceof S3ServiceException && (error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey')) {
          call.answer({ httpStatus: 404, response: { found: false } })
          return null
        }
        return asProviderError(error, 'GetObject')
      }
      const length = found.ContentLength ?? 0
      if (length > maxBytes) {
        found.Body?.transformToWebStream().cancel().catch(() => {})
        throw new TooLargeObjectError(`The object holds ${length} bytes; at most ${maxBytes} are read.`)
      }
      const body = Buffer.from((await found.Body?.transformToByteArray()) ?? new Uint8Array())
      if (body.length > maxBytes) throw new TooLargeObjectError(`The object holds more than ${maxBytes} bytes.`)
      call.answer({ httpStatus: 200, response: { sizeBytes: body.length } })
      return body
    },

    // ---- B-W2b-160 (COL-052): large uploads in parts ------------------------------------------------------------------
    async startMultipart(call: GatewayCall, target: { readonly key: string; readonly contentType: string }): Promise<string> {
      const { client, bucketOf } = await open(call)
      try {
        const started = await client.send(new CreateMultipartUploadCommand({ Bucket: bucketOf(target.key), Key: target.key, ContentType: target.contentType, ChecksumAlgorithm: 'SHA256' }), {
          abortSignal: call.signal,
        })
        if (!started.UploadId) throw new ProviderError('R2 CreateMultipartUpload: no upload id in the answer.', { retryable: false })
        call.answer({ httpStatus: 200 })
        return started.UploadId
      } catch (error) {
        if (error instanceof ProviderError) throw error
        return asProviderError(error, 'CreateMultipartUpload')
      }
    },

    async presignPart(call: GatewayCall, target: PartTarget): Promise<PresignedRequest> {
      const { client, bucketOf } = await open(call)
      const checksum = hexToBase64(target.sha256)
      const url = await getSignedUrl(
        client,
        new UploadPartCommand({ Bucket: bucketOf(target.key), Key: target.key, UploadId: target.uploadId, PartNumber: target.partNumber, ContentLength: target.sizeBytes, ChecksumSHA256: checksum }),
        {
          expiresIn: target.expiresInSeconds,
          signingDate: target.now,
          signableHeaders: new Set(['content-length', 'x-amz-checksum-sha256']),
          unhoistableHeaders: new Set(['x-amz-checksum-sha256']),
        },
      )
      return { method: 'PUT', url, headers: { 'x-amz-checksum-sha256': checksum }, expiresAt: new Date(target.now.getTime() + target.expiresInSeconds * 1000) }
    },

    async listParts(call: GatewayCall, key: string, uploadId: string): Promise<StoredPart[] | null> {
      const { client, bucketOf } = await open(call)
      const parts: StoredPart[] = []
      let marker: string | undefined
      try {
        for (let page = 0; page < 20; page++) {
          const listed = await client.send(new ListPartsCommand({ Bucket: bucketOf(key), Key: key, UploadId: uploadId, ...(marker ? { PartNumberMarker: marker } : {}) }), { abortSignal: call.signal })
          for (const part of listed.Parts ?? []) {
            if (part.PartNumber === undefined || !part.ETag) continue
            parts.push({ partNumber: part.PartNumber, etag: part.ETag, sizeBytes: part.Size ?? 0, sha256: part.ChecksumSHA256 ? base64ToHex(part.ChecksumSHA256) : null })
          }
          if (!listed.IsTruncated || !listed.NextPartNumberMarker) break
          marker = listed.NextPartNumberMarker
        }
      } catch (error) {
        if (error instanceof S3ServiceException && (error.name === 'NoSuchUpload' || error.$metadata?.httpStatusCode === 404)) {
          call.answer({ httpStatus: 404, response: { found: false } })
          return null
        }
        return asProviderError(error, 'ListParts')
      }
      call.answer({ httpStatus: 200, response: { parts: parts.length } })
      return parts.sort((a, b) => a.partNumber - b.partNumber)
    },

    async completeMultipart(call: GatewayCall, key: string, uploadId: string, parts: readonly StoredPart[]): Promise<void> {
      const { client, bucketOf } = await open(call)
      try {
        await client.send(
          new CompleteMultipartUploadCommand({
            Bucket: bucketOf(key),
            Key: key,
            UploadId: uploadId,
            MultipartUpload: {
              Parts: [...parts]
                .sort((a, b) => a.partNumber - b.partNumber)
                .map((part) => ({ PartNumber: part.partNumber, ETag: part.etag, ...(part.sha256 ? { ChecksumSHA256: hexToBase64(part.sha256) } : {}) })),
            },
          }),
          { abortSignal: call.signal },
        )
        call.answer({ httpStatus: 200, response: { parts: parts.length } })
      } catch (error) {
        asProviderError(error, 'CompleteMultipartUpload')
      }
    },

    async abortMultipart(call: GatewayCall, key: string, uploadId: string): Promise<void> {
      const { client, bucketOf } = await open(call)
      try {
        await client.send(new AbortMultipartUploadCommand({ Bucket: bucketOf(key), Key: key, UploadId: uploadId }), { abortSignal: call.signal })
        call.answer({ httpStatus: 204 })
      } catch (error) {
        if (error instanceof S3ServiceException && (error.name === 'NoSuchUpload' || error.$metadata?.httpStatusCode === 404)) {
          call.answer({ httpStatus: 404, response: { found: false } })
          return
        }
        asProviderError(error, 'AbortMultipartUpload')
      }
    },

    async digest(call: GatewayCall, key: string): Promise<ObjectDigest | null> {
      const { client, bucketOf } = await open(call)
      let found
      try {
        found = await client.send(new GetObjectCommand({ Bucket: bucketOf(key), Key: key }), { abortSignal: call.signal })
      } catch (error) {
        if (error instanceof S3ServiceException && (error.$metadata?.httpStatusCode === 404 || error.name === 'NoSuchKey')) {
          call.answer({ httpStatus: 404, response: { found: false } })
          return null
        }
        return asProviderError(error, 'GetObject')
      }
      const hash = createHash('sha256')
      let sizeBytes = 0
      for await (const chunk of (found.Body ?? []) as AsyncIterable<Uint8Array>) {
        hash.update(chunk)
        sizeBytes += chunk.length
      }
      call.answer({ httpStatus: 200, response: { sizeBytes } })
      return { sizeBytes, contentType: found.ContentType ?? null, sha256: hash.digest('hex') }
    },
  }
}
