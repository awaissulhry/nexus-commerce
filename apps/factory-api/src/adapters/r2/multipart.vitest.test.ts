import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import type { GatewayCall } from '../../platform/gateway/gateway'
import { r2FileStore } from './r2'
import { FakeR2 } from './testing'

// B-W2b-160 (COL-052): R2 multipart through the S3 API against the fake transport: what is signed, what is sent, how the
// answers are read. Presigning a part sends nothing; the parts themselves go from the browser to R2 (here: sendPart).

const NOW = new Date('2026-11-05T10:00:00.000Z')
const KEY = 't/0199f0a0-0000-7000-8000-000000000001/c/0199f0a0-0000-7000-8000-000000000002/2026/3b1f0c3e-8d1a-4c2b-9f3e-2a1b0c9d8e7f'
const SETTINGS = { endpoint: 'https://example-account.eu.r2.cloudflarestorage.com', bucket: 'factory-test', legalBucket: 'factory-test-legal' }
const sha = (body: Buffer) => createHash('sha256').update(body).digest('hex')

function call(fields: Partial<AdapterAccount> = {}): GatewayCall & { answers: unknown[] } {
  const answers: unknown[] = []
  return {
    account: { id: 'a', tenantId: 't', companyId: null, provider: 'R2', mode: 'LIVE', settings: SETTINGS, ...fields },
    attempt: 1,
    signal: new AbortController().signal,
    idempotencyKey: null,
    credentials: async <T>() => ({ accessKeyId: 'made-up-access-key-id', secretAccessKey: 'made-up-secret-access-key' }) as T,
    answer: (details) => answers.push(details),
    answers,
  }
}

describe('R2 multipart (COL-052)', () => {
  it('starts with the type and SHA-256 part checksums, presigns a part with its length and checksum signed, lists, joins and reads it back', async () => {
    const r2 = new FakeR2()
    const store = r2FileStore({ clientFor: r2.clientFor })
    const uploadId = await store.startMultipart(call(), { key: KEY, contentType: 'application/pdf' })
    expect(uploadId).toMatch(/^made-up-upload-/)
    const start = r2.requests.at(-1)!
    expect(start).toMatchObject({ method: 'POST', path: `/factory-test/${KEY}` })
    expect(Object.entries(start.headers).find(([name]) => name.toLowerCase() === 'x-amz-checksum-algorithm')?.[1]).toBe('SHA256')

    const one = Buffer.alloc(5 * 1_048_576, 1)
    const two = Buffer.from('%PDF made-up tail')
    const part = await store.presignPart(call(), { key: KEY, uploadId, partNumber: 2, sizeBytes: two.length, sha256: sha(two), expiresInSeconds: 900, now: NOW })
    const url = new URL(part.url)
    expect(url.searchParams.get('partNumber')).toBe('2')
    expect(url.searchParams.get('uploadId')).toBe(uploadId)
    expect(url.searchParams.get('X-Amz-Expires')).toBe('900')
    expect(url.searchParams.get('X-Amz-SignedHeaders')).toBe('content-length;host;x-amz-checksum-sha256')
    expect(part.headers).toEqual({ 'x-amz-checksum-sha256': Buffer.from(sha(two), 'hex').toString('base64') })
    expect(r2.requests.length).toBe(1)

    r2.sendPart(uploadId, 2, two)
    r2.sendPart(uploadId, 1, one)
    const parts = await store.listParts(call(), KEY, uploadId)
    expect(parts).toEqual([
      { partNumber: 1, etag: expect.stringMatching(/^"[0-9a-f]{32}"$/), sizeBytes: one.length, sha256: sha(one) },
      { partNumber: 2, etag: expect.stringMatching(/^"[0-9a-f]{32}"$/), sizeBytes: two.length, sha256: sha(two) },
    ])
    await store.completeMultipart(call(), KEY, uploadId, parts!)
    const joined = Buffer.concat([one, two])
    // R2's HEAD of a joined object carries no SHA-256 of the file: the digest reads it.
    expect((await store.head(call(), KEY))?.sha256).toBeNull()
    expect(await store.digest(call(), KEY)).toEqual({ sizeBytes: joined.length, contentType: 'application/pdf', sha256: sha(joined) })
    // Gone from the store's open uploads: listing it now answers null, aborting it is not an error.
    expect(await store.listParts(call(), KEY, uploadId)).toBeNull()
    await store.abortMultipart(call(), KEY, uploadId)
  })

  it('aborts an open upload, and reads no object as null', async () => {
    const r2 = new FakeR2()
    const store = r2FileStore({ clientFor: r2.clientFor })
    const uploadId = await store.startMultipart(call(), { key: KEY, contentType: 'image/jpeg' })
    await store.abortMultipart(call(), KEY, uploadId)
    expect(r2.uploads.size).toBe(0)
    expect(await store.digest(call(), KEY)).toBeNull()
  })

  it('refuses a FAKE account (the local store serves those)', async () => {
    const store = r2FileStore({ clientFor: new FakeR2().clientFor })
    await expect(store.startMultipart(call({ mode: 'FAKE' }), { key: KEY, contentType: 'application/pdf' })).rejects.toThrow('local file store')
  })
})
