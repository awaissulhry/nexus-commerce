import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { r2FileStore } from './r2'
import { FakeR2 } from './testing'

// The R2 adapter against a fake R2 (the real S3 client, an in-memory transport): what it signs, what it sends, and how
// it reads the answers. Presigning sends nothing; HEAD and DELETE reach only the fake.

const NOW = new Date('2026-10-28T10:00:00.000Z')
const SHA = 'ab'.repeat(32)
const KEY = 't/0199f0a0-0000-7000-8000-000000000001/c/0199f0a0-0000-7000-8000-000000000002/2026/3b1f0c3e-8d1a-4c2b-9f3e-2a1b0c9d8e7f'
const LEGAL = `legal/${KEY}`
const SETTINGS = { endpoint: 'https://example-account.eu.r2.cloudflarestorage.com', bucket: 'factory-test', legalBucket: 'factory-test-legal' }
const CREDENTIALS = { accessKeyId: 'made-up-access-key-id', secretAccessKey: 'made-up-secret-access-key' }

function call(fields: Partial<AdapterAccount> = {}, credentials: unknown = CREDENTIALS): GatewayCall & { answers: unknown[] } {
  const answers: unknown[] = []
  return {
    account: { id: 'a', tenantId: 't', companyId: null, provider: 'R2', mode: 'LIVE', settings: SETTINGS, ...fields },
    attempt: 1,
    signal: new AbortController().signal,
    idempotencyKey: null,
    credentials: async <T>() => credentials as T,
    answer: (details) => answers.push(details),
    answers,
  }
}

describe('the R2 file store', () => {
  it('presigns a PUT with the type, length and SHA-256 signed, and sends nothing', async () => {
    const r2 = new FakeR2()
    const put = await r2FileStore({ clientFor: r2.clientFor }).presignUpload(call(), {
      key: KEY,
      contentType: 'application/pdf',
      sizeBytes: 1234,
      sha256: SHA,
      expiresInSeconds: 300,
      now: NOW,
    })
    const url = new URL(put.url)
    expect(url.origin).toBe(SETTINGS.endpoint)
    expect(decodeURIComponent(url.pathname)).toBe(`/factory-test/${KEY}`)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('300')
    expect(url.searchParams.get('X-Amz-Date')).toBe('20261028T100000Z')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;content-type;host;x-amz-checksum-sha256')
    expect(url.searchParams.get('X-Amz-Credential')).toMatch(/^made-up-access-key-id\/20261028\/auto\/s3\/aws4_request$/)
    expect(put.url).not.toContain(CREDENTIALS.secretAccessKey)
    expect(put).toMatchObject({
      method: 'PUT',
      headers: { 'content-type': 'application/pdf', 'x-amz-checksum-sha256': Buffer.from(SHA, 'hex').toString('base64') },
      expiresAt: new Date('2026-10-28T10:05:00.000Z'),
    })
    expect(r2.requests).toEqual([])
    expect(r2.configs[0]).toMatchObject({ region: 'auto', forcePathStyle: true, maxAttempts: 1, requestChecksumCalculation: 'WHEN_REQUIRED' })
  })

  it('presigns a GET as an attachment, and the fiscal archive in the legal bucket', async () => {
    const r2 = new FakeR2()
    const get = await r2FileStore({ clientFor: r2.clientFor }).presignDownload(call(), {
      key: LEGAL,
      contentType: 'application/xml',
      disposition: 'attachment; filename="invoice.xml"',
      expiresInSeconds: 60,
      now: NOW,
    })
    const url = new URL(get.url)
    expect(decodeURIComponent(url.pathname)).toBe(`/factory-test-legal/${LEGAL}`)
    expect(url.searchParams.get('response-content-disposition')).toBe('attachment; filename="invoice.xml"')
    expect(url.searchParams.get('response-content-type')).toBe('application/xml')
    expect(url.searchParams.get('X-Amz-Expires')).toBe('60')
    expect(get).toMatchObject({ method: 'GET', headers: {}, expiresAt: new Date('2026-10-28T10:01:00.000Z') })
    expect(r2.requests).toEqual([])
    // Without a legal bucket, the fiscal archive stays in the one bucket.
    const plain = await r2FileStore({ clientFor: r2.clientFor }).presignDownload(call({ settings: { ...SETTINGS, legalBucket: undefined } }), {
      key: LEGAL,
      contentType: 'application/xml',
      disposition: 'attachment',
      expiresInSeconds: 60,
      now: NOW,
    })
    expect(decodeURIComponent(new URL(plain.url).pathname)).toBe(`/factory-test/${LEGAL}`)
  })

  it('reads size, type and SHA-256 with HEAD (checksum mode on); no object is null', async () => {
    const r2 = new FakeR2()
    const store = r2FileStore({ clientFor: r2.clientFor })
    r2.put('factory-test', KEY, { sizeBytes: 1234, contentType: 'application/pdf', sha256: SHA })
    const found = call()
    expect(await store.head(found, KEY)).toEqual({ sizeBytes: 1234, contentType: 'application/pdf', sha256: SHA })
    expect(found.answers).toEqual([{ httpStatus: 200, response: { sizeBytes: 1234, contentType: 'application/pdf' } }])
    const missing = call()
    expect(await store.head(missing, LEGAL)).toBeNull()
    expect(missing.answers).toEqual([{ httpStatus: 404, response: { found: false } }])
    expect(r2.requests.map((request) => [request.method, request.hostname, request.path, request.headers['x-amz-checksum-mode']])).toEqual([
      ['HEAD', 'example-account.eu.r2.cloudflarestorage.com', `/factory-test/${KEY}`, 'ENABLED'],
      ['HEAD', 'example-account.eu.r2.cloudflarestorage.com', `/factory-test-legal/${LEGAL}`, 'ENABLED'],
    ])
  })

  it('puts bytes the API made with PutObject: type, length and SHA-256 sent, the fiscal archive in the legal bucket', async () => {
    const r2 = new FakeR2()
    const body = Buffer.from('%PDF-1.7 made-up generated document')
    const sha256 = createHash('sha256').update(body).digest('hex')
    const put = call()
    await r2FileStore({ clientFor: r2.clientFor }).put(put, { key: LEGAL, contentType: 'application/pdf', body, sha256 })
    expect(put.answers).toEqual([{ httpStatus: 200 }])
    expect(r2.objects.get(`/factory-test-legal/${LEGAL}`)).toEqual({ sizeBytes: body.length, contentType: 'application/pdf', sha256 })
    expect(r2.requests.map((request) => [request.method, request.path, request.headers['x-amz-checksum-sha256']])).toEqual([
      ['PUT', `/factory-test-legal/${LEGAL}`, Buffer.from(sha256, 'hex').toString('base64')],
    ])
  })

  it('deletes with DeleteObject', async () => {
    const r2 = new FakeR2()
    r2.put('factory-test', KEY, { sizeBytes: 1, contentType: 'image/png', sha256: SHA })
    await r2FileStore({ clientFor: r2.clientFor }).remove(call(), KEY)
    expect(r2.objects.size).toBe(0)
    expect(r2.requests.map((request) => request.method)).toEqual(['DELETE'])
  })

  it('turns an R2 error answer into the gateway\'s ProviderError (5xx retryable, 4xx final)', async () => {
    const r2 = new FakeR2()
    const store = r2FileStore({ clientFor: r2.clientFor })
    r2.failNext = 503
    const busy = await store.head(call(), KEY).catch((error: unknown) => error)
    expect(busy).toBeInstanceOf(ProviderError)
    expect(busy).toMatchObject({ httpStatus: 503, retryable: true })
    r2.failNext = 403
    expect(await store.remove(call(), KEY).catch((error: unknown) => error)).toMatchObject({ httpStatus: 403, retryable: false })
  })

  it('refuses a FAKE account, bad settings and missing credentials before anything is sent', async () => {
    const r2 = new FakeR2()
    const store = r2FileStore({ clientFor: r2.clientFor })
    const cases: GatewayCall[] = [
      call({ mode: 'FAKE' }),
      call({ settings: { ...SETTINGS, endpoint: 'http://insecure.example.com' } }),
      call({ settings: { endpoint: SETTINGS.endpoint } }),
      call({ settings: null }),
      call({}, null),
      call({}, { accessKeyId: 'only-half' }),
    ]
    for (const bad of cases) await expect(store.head(bad, KEY)).rejects.toMatchObject({ name: 'ProviderError', retryable: false })
    expect(r2.requests).toEqual([])
  })
})
