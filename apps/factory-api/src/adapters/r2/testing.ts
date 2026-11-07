import { createHash } from 'node:crypto'
import { Readable } from 'node:stream'
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'

/**
 * A fake R2 for tests (imported by tests only): the real S3 client, with a request handler that answers from memory
 * instead of opening a socket. Every request the SDK would send is recorded, so a test can prove which calls reached
 * "R2" and that nothing else did. HEAD answers with the stored size, type and SHA-256 checksum; GET with the stored
 * body (an object put with one); PUT keeps what a PutObject sent; DELETE removes.
 */

export interface FakeObject {
  readonly sizeBytes: number
  readonly contentType: string
  /** Lower-case hex. */
  readonly sha256: string
  /** The bytes GET answers with (an object without them answers an empty body). */
  readonly body?: Buffer
}

export interface RecordedRequest {
  readonly method: string
  readonly hostname: string
  readonly path: string
  readonly headers: Readonly<Record<string, string>>
}

export class FakeR2 {
  readonly objects = new Map<string, FakeObject>()
  readonly requests: RecordedRequest[] = []
  /** The status of the next answer instead of the real one (a provider failure). */
  failNext: number | null = null
  readonly configs: S3ClientConfig[] = []

  /** `bucket/key` as R2 sees it (path style). */
  put(bucket: string, key: string, object: FakeObject): void {
    this.objects.set(`/${bucket}/${key}`, object)
  }

  /** B-W2b-160 (COL-052): multipart uploads by upload id: the object's path, its type and the parts sent so far. */
  readonly uploads = new Map<string, { path: string; contentType: string; parts: Map<number, Buffer> }>()
  private nextUpload = 1

  /** What a browser's presigned UploadPart would store (presigned PUTs never reach this fake through the SDK). */
  sendPart(uploadId: string, partNumber: number, body: Buffer): void {
    const upload = this.uploads.get(uploadId)
    if (!upload) throw new Error(`no multipart upload ${uploadId}`)
    upload.parts.set(partNumber, body)
  }

  private multipart(request: { method: string; path: string; headers: Record<string, string>; query?: Record<string, unknown>; body?: unknown }) {
    const query = request.query ?? {}
    const path = decodeURIComponent(request.path)
    const xml = (statusCode: number, text: string) => ({ response: { statusCode, headers: { 'content-type': 'application/xml' }, body: Readable.from([Buffer.from(text)]) } })
    const noSuchUpload = () => xml(404, '<Error><Code>NoSuchUpload</Code><Message>made-up: no such upload</Message></Error>')
    const etag = (body: Buffer) => `"${createHash('md5').update(body).digest('hex')}"`
    const checksum = (body: Buffer) => createHash('sha256').update(body).digest('base64')
    if (request.method === 'POST' && 'uploads' in query) {
      const uploadId = `made-up-upload-${this.nextUpload++}`
      const contentType = Object.entries(request.headers).find(([name]) => name.toLowerCase() === 'content-type')?.[1] ?? 'application/octet-stream'
      this.uploads.set(uploadId, { path, contentType, parts: new Map() })
      const [, bucket, ...key] = path.split('/')
      return xml(200, `<InitiateMultipartUploadResult><Bucket>${bucket}</Bucket><Key>${key.join('/')}</Key><UploadId>${uploadId}</UploadId></InitiateMultipartUploadResult>`)
    }
    const uploadId = typeof query.uploadId === 'string' ? query.uploadId : null
    const upload = uploadId ? this.uploads.get(uploadId) : undefined
    if (request.method === 'GET') {
      if (!upload) return noSuchUpload()
      const parts = [...upload.parts.entries()]
        .sort(([a], [b]) => a - b)
        .map(([number, body]) => `<Part><PartNumber>${number}</PartNumber><ETag>${etag(body)}</ETag><Size>${body.length}</Size><ChecksumSHA256>${checksum(body)}</ChecksumSHA256></Part>`)
      return xml(200, `<ListPartsResult><UploadId>${uploadId}</UploadId><IsTruncated>false</IsTruncated>${parts.join('')}</ListPartsResult>`)
    }
    if (request.method === 'POST') {
      if (!upload) return noSuchUpload()
      const asked = [...String(request.body ?? '').matchAll(/<PartNumber>(\d+)<\/PartNumber>/g)].map((match) => Number(match[1]))
      const body = Buffer.concat(asked.map((number) => upload.parts.get(number) ?? Buffer.alloc(0)))
      // Like R2: the joined object's checksum is the parts' (a composite), not the SHA-256 of its bytes.
      this.objects.set(upload.path, { sizeBytes: body.length, contentType: upload.contentType, sha256: '', body })
      this.uploads.delete(uploadId!)
      return xml(200, `<CompleteMultipartUploadResult><ETag>"made-up-${asked.length}"</ETag></CompleteMultipartUploadResult>`)
    }
    if (request.method === 'DELETE') {
      if (!upload) return noSuchUpload()
      this.uploads.delete(uploadId!)
      return { response: { statusCode: 204, headers: {}, body: undefined } }
    }
    return { response: { statusCode: 405, headers: {}, body: undefined } }
  }

  /** The adapter's `clientFor`: a real S3Client whose transport is this fake. */
  readonly clientFor = (config: S3ClientConfig): S3Client => {
    this.configs.push(config)
    return new S3Client({ ...config, requestHandler: { handle: (request: Parameters<FakeR2['handle']>[0]) => this.handle(request) } as never })
  }

  async handle(request: { method: string; hostname: string; path: string; headers: Record<string, string>; query?: Record<string, unknown>; body?: unknown }) {
    this.requests.push({ method: request.method, hostname: request.hostname, path: decodeURIComponent(request.path), headers: { ...request.headers } })
    const status = this.failNext
    this.failNext = null
    if (status !== null) return { response: { statusCode: status, headers: {}, body: undefined } }
    // B-W2b-160: a multipart request (?uploads, ?uploadId=…) is answered by multipart().
    if (request.query && ('uploads' in request.query || 'uploadId' in request.query)) return this.multipart(request)
    const object = this.objects.get(decodeURIComponent(request.path))
    if (request.method === 'HEAD') {
      if (!object) return { response: { statusCode: 404, headers: {}, body: undefined } }
      return {
        response: {
          statusCode: 200,
          headers: {
            'content-length': String(object.sizeBytes),
            'content-type': object.contentType,
            'x-amz-checksum-sha256': Buffer.from(object.sha256, 'hex').toString('base64'),
            etag: '"fake"',
          },
          body: undefined,
        },
      }
    }
    if (request.method === 'GET') {
      if (!object) return { response: { statusCode: 404, headers: { 'content-type': 'application/xml' }, body: Readable.from([Buffer.from('<Error><Code>NoSuchKey</Code></Error>')]) } }
      const body = object.body ?? Buffer.alloc(0)
      return {
        response: {
          statusCode: 200,
          headers: { 'content-length': String(body.length), 'content-type': object.contentType, etag: '"fake"' },
          body: Readable.from([body]),
        },
      }
    }
    if (request.method === 'PUT') {
      // A PutObject (presigned PUTs never reach this fake: the browser sends them). Size, type and checksum as sent.
      const header = (name: string): string | undefined => Object.entries(request.headers).find(([key]) => key.toLowerCase() === name)?.[1]
      this.objects.set(decodeURIComponent(request.path), {
        sizeBytes: Number.parseInt(header('content-length') ?? '0', 10),
        contentType: header('content-type') ?? 'application/octet-stream',
        sha256: Buffer.from(header('x-amz-checksum-sha256') ?? '', 'base64').toString('hex'),
      })
      return { response: { statusCode: 200, headers: { etag: '"fake"' }, body: undefined } }
    }
    if (request.method === 'DELETE') {
      this.objects.delete(decodeURIComponent(request.path))
      return { response: { statusCode: 204, headers: {}, body: undefined } }
    }
    return { response: { statusCode: 405, headers: {}, body: undefined } }
  }
}
