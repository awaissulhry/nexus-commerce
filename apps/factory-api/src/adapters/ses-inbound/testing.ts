import { Readable } from 'node:stream'
import { S3Client, type S3ClientConfig } from '@aws-sdk/client-s3'

/**
 * A fake S3 for the receiving bucket's adapter (imported by tests only): the real S3 client, with a request handler that
 * answers from memory instead of opening a socket. Every request the SDK would send is recorded, so a test proves what
 * reached "S3" (and that nothing else did): no network. Objects are kept by `<host>/<path>` as the SDK addresses them
 * (virtual-hosted style: `<bucket>.s3.<region>.amazonaws.com/<key>`).
 */
export class FakeS3Transport {
  readonly objects = new Map<string, Buffer>()
  readonly requests: { readonly method: string; readonly hostname: string; readonly path: string; readonly headers: Readonly<Record<string, string>> }[] = []
  readonly configs: S3ClientConfig[] = []
  /** The status of the next answer instead of the real one (a provider failure). */
  failNext: number | null = null

  put(bucket: string, key: string, body: string | Buffer, region = 'eu-south-1'): void {
    this.objects.set(`${bucket}.s3.${region}.amazonaws.com/${key}`, Buffer.from(body))
  }

  readonly clientFor = (config: S3ClientConfig): S3Client => {
    this.configs.push(config)
    return new S3Client({ ...config, requestHandler: { handle: (request: Parameters<FakeS3Transport['handle']>[0]) => this.handle(request) } as never })
  }

  async handle(request: { method: string; hostname: string; path: string; headers: Record<string, string> }) {
    this.requests.push({ method: request.method, hostname: request.hostname, path: decodeURIComponent(request.path), headers: { ...request.headers } })
    const status = this.failNext
    this.failNext = null
    if (status !== null) return { response: { statusCode: status, headers: {}, body: Readable.from([Buffer.from('<Error><Code>InternalError</Code></Error>')]) } }
    const object = request.method === 'GET' ? this.objects.get(`${request.hostname}${decodeURIComponent(request.path)}`) : undefined
    if (!object) return { response: { statusCode: 404, headers: { 'content-type': 'application/xml' }, body: Readable.from([Buffer.from('<Error><Code>NoSuchKey</Code></Error>')]) } }
    return { response: { statusCode: 200, headers: { 'content-length': String(object.length), 'content-type': 'application/octet-stream', etag: '"fake"' }, body: Readable.from([object]) } }
  }
}
