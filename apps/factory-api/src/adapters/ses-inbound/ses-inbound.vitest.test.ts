import { describe, expect, it } from 'vitest'
import type { AdapterAccount } from '@nexus/factory-domain/ports/provider'
import { ProviderError, type GatewayCall } from '../../platform/gateway/gateway'
import { FakeMailBucket } from './fake'
import { inboundS3Store } from './s3'
import { FakeS3Transport } from './testing'

// The receiving bucket's adapters: S3 on the real client with a fake transport (no network), and the fake bucket.

const ACCESS_KEY = 'made-up-access-key-id-02'
const SECRET_KEY = 'made-up-secret-access-key-for-tests-only'
const BUCKET = 'factory-inbound-test'
const KEY = 'inbound/0ab1cd2ef3'

function callFor(mode: AdapterAccount['mode'], settings: unknown = { region: 'eu-south-1', inboundBucket: BUCKET }, credentials: unknown = { accessKeyId: ACCESS_KEY, secretAccessKey: SECRET_KEY }) {
  const answers: unknown[] = []
  const call: GatewayCall = {
    account: { id: '01a18208-e882-70ce-8bb6-0d4afb932bd3', tenantId: '01a18208-e882-70ce-8bb6-0d4afb932bd1', companyId: null, provider: 'SES', mode, settings },
    attempt: 1,
    signal: new AbortController().signal,
    idempotencyKey: null,
    credentials: async <T>() => credentials as T,
    answer: (details) => void answers.push(details),
  }
  return { call, answers }
}

describe('the S3 receiving bucket (real client, fake transport)', () => {
  it("reads the object SES stored, from the account's bucket, signed with the account key", async () => {
    const s3 = new FakeS3Transport()
    s3.put(BUCKET, KEY, 'From: a@example.com\r\n\r\nhello')
    const { call, answers } = callFor('SANDBOX')
    const body = await inboundS3Store({ clientFor: s3.clientFor }).fetch(call, { bucket: BUCKET, key: KEY }, 1_000)
    expect(body?.toString('utf8')).toBe('From: a@example.com\r\n\r\nhello')
    expect(s3.requests).toHaveLength(1)
    expect(s3.requests[0]).toMatchObject({ method: 'GET', hostname: `${BUCKET}.s3.eu-south-1.amazonaws.com`, path: `/${KEY}` })
    expect(s3.requests[0]!.headers.authorization).toContain(`Credential=${ACCESS_KEY}/`)
    expect(s3.configs[0]).toMatchObject({ region: 'eu-south-1', maxAttempts: 1 })
    expect(answers).toEqual([{ httpStatus: 200, response: { sizeBytes: 28 } }])
  })

  it('refuses another bucket, missing settings or keys before sending anything; a missing object is null; a large one is refused', async () => {
    const s3 = new FakeS3Transport()
    const store = inboundS3Store({ clientFor: s3.clientFor })
    await expect(store.fetch(callFor('LIVE').call, { bucket: 'someone-elses', key: KEY }, 1_000)).rejects.toThrow(/another bucket/)
    await expect(store.fetch(callFor('LIVE', {}).call, { bucket: BUCKET, key: KEY }, 1_000)).rejects.toThrow(/inboundBucket/)
    await expect(store.fetch(callFor('LIVE', undefined, null).call, { bucket: BUCKET, key: KEY }, 1_000)).rejects.toThrow(/no access key/)
    await expect(store.fetch(callFor('FAKE').call, { bucket: BUCKET, key: KEY }, 1_000)).rejects.toThrow(ProviderError)
    expect(s3.requests).toHaveLength(0)

    expect(await store.fetch(callFor('LIVE').call, { bucket: BUCKET, key: 'inbound/gone' }, 1_000)).toBeNull()
    s3.put(BUCKET, KEY, Buffer.alloc(2_000, 0x41))
    await expect(store.fetch(callFor('LIVE').call, { bucket: BUCKET, key: KEY }, 1_000)).rejects.toMatchObject({ name: 'ProviderError', retryable: false, message: expect.stringMatching(/at most 1000/) })
    s3.failNext = 503
    const failure = await store.fetch(callFor('LIVE').call, { bucket: BUCKET, key: KEY }, 10_000).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(ProviderError)
    expect((failure as ProviderError).retryable).toBe(true)
  })

  it('uses the environment keys for an account without sealed ones', async () => {
    const s3 = new FakeS3Transport()
    s3.put(BUCKET, KEY, 'x')
    const store = inboundS3Store({ clientFor: s3.clientFor, environmentCredentials: { accessKeyId: 'made-up-env-key', secretAccessKey: 'made-up-env-secret-key' } })
    await store.fetch(callFor('LIVE', undefined, null).call, { bucket: BUCKET, key: KEY }, 10)
    expect(s3.requests[0]!.headers.authorization).toContain('Credential=made-up-env-key/')
  })
})

describe('the fake receiving bucket', () => {
  it('answers what a test put, for FAKE accounts only, in memory', async () => {
    const bucket = new FakeMailBucket()
    bucket.put({ bucket: BUCKET, key: KEY }, 'raw mail')
    const { call, answers } = callFor('FAKE')
    expect((await bucket.fetch(call, { bucket: BUCKET, key: KEY }, 100))?.toString()).toBe('raw mail')
    expect(answers).toEqual([{ httpStatus: 200, response: { sizeBytes: 8 } }])
    expect(await bucket.fetch(call, { bucket: BUCKET, key: 'other' }, 100)).toBeNull()
    await expect(bucket.fetch(call, { bucket: BUCKET, key: KEY }, 3)).rejects.toMatchObject({ name: 'ProviderError', retryable: false })
    await expect(bucket.fetch(callFor('LIVE').call, { bucket: BUCKET, key: KEY }, 100)).rejects.toThrow(/FAKE/)
    bucket.failNext = { httpStatus: 503, message: 'SlowDown' }
    await expect(bucket.fetch(call, { bucket: BUCKET, key: KEY }, 100)).rejects.toThrow(/SlowDown/)
    bucket.remove({ bucket: BUCKET, key: KEY })
    expect(await bucket.fetch(call, { bucket: BUCKET, key: KEY }, 100)).toBeNull()
  })
})
