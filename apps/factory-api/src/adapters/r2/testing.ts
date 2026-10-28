import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'

/**
 * A fake R2 for tests (imported by tests only): the real S3 client, with a request handler that answers from memory
 * instead of opening a socket. Every request the SDK would send is recorded, so a test can prove which calls reached
 * "R2" and that nothing else did. HEAD answers with the stored size, type and SHA-256 checksum; DELETE removes.
 */

export interface FakeObject {
  readonly sizeBytes: number
  readonly contentType: string
  /** Lower-case hex. */
  readonly sha256: string
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

  /** The adapter's `clientFor`: a real S3Client whose transport is this fake. */
  readonly clientFor = (config: S3ClientConfig): S3Client => {
    this.configs.push(config)
    return new S3Client({ ...config, requestHandler: { handle: (request: Parameters<FakeR2['handle']>[0]) => this.handle(request) } as never })
  }

  async handle(request: { method: string; hostname: string; path: string; headers: Record<string, string> }) {
    this.requests.push({ method: request.method, hostname: request.hostname, path: decodeURIComponent(request.path), headers: { ...request.headers } })
    const status = this.failNext
    this.failNext = null
    if (status !== null) return { response: { statusCode: status, headers: {}, body: undefined } }
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
    if (request.method === 'DELETE') {
      this.objects.delete(decodeURIComponent(request.path))
      return { response: { statusCode: 204, headers: {}, body: undefined } }
    }
    return { response: { statusCode: 405, headers: {}, body: undefined } }
  }
}
