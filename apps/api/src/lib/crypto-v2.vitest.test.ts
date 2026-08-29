/**
 * CX.1 — v2 KMS envelope encryption for credential blobs.
 *
 * No AWS, no mocking library: a FakeKms object with a `send(command)`
 * method is injected through __cryptoTest.setKmsClient. It wraps data
 * keys under its own random master key with the EncryptionContext bound
 * as GCM AAD, so a wrong context or a tampered wrapped key is refused
 * the way real KMS refuses it (InvalidCiphertextException).
 *
 * The tests that matter most are the REFUSALS and the non-leak: a
 * decrypt that cannot fail, or an error that quotes the DEK, would be
 * worse than no encryption at all.
 */

import crypto from 'node:crypto'
import { describe, it, expect, beforeAll, beforeEach, afterAll, afterEach, vi } from 'vitest'
import {
  encryptSecret,
  encryptCredentials,
  decryptCredentials,
  reencryptCredentials,
  credentialsKeyIdOf,
  isCredentialsBlob,
  isEncrypted,
  onCredentialsKmsFallback,
  CredentialsDecryptError,
  __test,
  __cryptoTest,
} from './crypto.js'

const EXPECTED_CONTEXT = { app: 'nexus', purpose: 'credentials' }
const ARN_KEY_ID = 'arn:aws:kms:eu-west-1:123456789012:key/0f3d2a1c-7b6e-4d5f-9a8b-1c2d3e4f5a6b'

interface KmsInput {
  KeyId?: string
  KeySpec?: string
  CiphertextBlob?: Uint8Array
  EncryptionContext?: Record<string, string>
}

function kmsError(name: string, message: string): Error {
  const err = new Error(message)
  err.name = name
  return err
}

function sameContext(a: Record<string, string> | undefined, b: Record<string, string>): boolean {
  if (!a) return false
  const ka = Object.keys(a).sort()
  const kb = Object.keys(b).sort()
  return ka.length === kb.length && ka.every((k, i) => k === kb[i] && a[k] === b[k])
}

/**
 * Enough of KMS to test against. Wrapped DEK = iv(12) | tag(16) | ct,
 * AES-256-GCM under a random master key, AAD = canonical JSON of the
 * EncryptionContext used at GenerateDataKey time.
 */
class FakeKms {
  private readonly master = crypto.randomBytes(32)
  keyId: string
  /** When set, Decrypt refuses any context that does not deep-equal this. */
  requiredContext: Record<string, string> | null = null
  failGenerate = false
  generateCalls: KmsInput[] = []
  decryptCalls: KmsInput[] = []
  /** The last plaintext DEK handed out — so tests can prove it never leaks. */
  lastDek: Buffer | null = null

  constructor(keyId = ARN_KEY_ID) {
    this.keyId = keyId
  }

  async send(command: { constructor: { name: string }; input: KmsInput }): Promise<unknown> {
    const kind = command.constructor?.name
    const input = command.input
    if (kind === 'GenerateDataKeyCommand' || (kind === undefined && input.KeySpec)) {
      this.generateCalls.push(input)
      if (this.failGenerate) throw kmsError('KMSInternalException', 'simulated KMS outage')
      if (input.KeySpec !== 'AES_256') throw kmsError('ValidationException', 'bad KeySpec')
      if (!input.KeyId) throw kmsError('ValidationException', 'KeyId required')
      const dek = crypto.randomBytes(32)
      this.lastDek = Buffer.from(dek)
      return {
        Plaintext: new Uint8Array(dek),
        CiphertextBlob: new Uint8Array(this.wrap(dek, input.EncryptionContext ?? {})),
        KeyId: this.keyId,
      }
    }
    if (kind === 'DecryptCommand' || (kind === undefined && input.CiphertextBlob)) {
      this.decryptCalls.push(input)
      if (this.requiredContext && !sameContext(input.EncryptionContext, this.requiredContext)) {
        throw kmsError('InvalidCiphertextException', 'encryption context mismatch')
      }
      const dek = this.unwrap(Buffer.from(input.CiphertextBlob ?? new Uint8Array()), input.EncryptionContext ?? {})
      return { Plaintext: new Uint8Array(dek), KeyId: this.keyId }
    }
    throw new Error(`FakeKms: unknown command ${kind}`)
  }

  private aad(ctx: Record<string, string>): Buffer {
    const sorted = Object.keys(ctx).sort().map((k) => [k, ctx[k]])
    return Buffer.from(JSON.stringify(sorted), 'utf8')
  }

  private wrap(dek: Buffer, ctx: Record<string, string>): Buffer {
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', this.master, iv)
    cipher.setAAD(this.aad(ctx))
    const ct = Buffer.concat([cipher.update(dek), cipher.final()])
    return Buffer.concat([iv, cipher.getAuthTag(), ct])
  }

  private unwrap(wrapped: Buffer, ctx: Record<string, string>): Buffer {
    if (wrapped.length < 28) throw kmsError('InvalidCiphertextException', 'ciphertext too short')
    try {
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.master, wrapped.subarray(0, 12))
      decipher.setAAD(this.aad(ctx))
      decipher.setAuthTag(wrapped.subarray(12, 28))
      return Buffer.concat([decipher.update(wrapped.subarray(28)), decipher.final()])
    } catch {
      throw kmsError('InvalidCiphertextException', 'ciphertext or context invalid')
    }
  }
}

/** Split a v2 blob into editable pieces and put it back together. */
function splitV2(blob: string): { kid: string; parts: string[] } {
  expect(blob.startsWith('v2:')).toBe(true)
  const body = blob.slice(3)
  const sep = body.indexOf(':')
  return { kid: body.slice(0, sep), parts: body.slice(sep + 1).split('.') }
}
function joinV2(kid: string, parts: string[]): string {
  return `v2:${kid}:${parts.join('.')}`
}
function flipByte(b64url: string, at = 0): string {
  const buf = Buffer.from(b64url, 'base64url')
  buf[at] ^= 0x01
  return buf.toString('base64url')
}
function flipChar(s: string, at: number): string {
  const c = s[at] === 'A' ? 'B' : 'A'
  return s.slice(0, at) + c + s.slice(at + 1)
}

async function expectDecryptError(blob: string, code: CredentialsDecryptError['code']): Promise<CredentialsDecryptError> {
  let caught: unknown
  try {
    await decryptCredentials(blob)
  } catch (err) {
    caught = err
  }
  expect(caught).toBeInstanceOf(CredentialsDecryptError)
  expect((caught as CredentialsDecryptError).code).toBe(code)
  return caught as CredentialsDecryptError
}

const SAMPLE = { accessToken: 'at_2f9c…sample', refreshToken: 'rt_sample', scopes: ['sell.inventory'], expiresIn: 7200, nested: { a: 1 } }

const envKey = crypto.randomBytes(32).toString('base64')
const prevEnv = { key: process.env.NEXUS_CREDENTIAL_ENC_KEY, kms: process.env.NEXUS_KMS_KEY_ID }
let fake: FakeKms

beforeAll(() => {
  process.env.NEXUS_CREDENTIAL_ENC_KEY = envKey
  __test.resetKeyCache()
  // logger.warn goes to console.warn; keep the run readable.
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})

afterAll(() => {
  if (prevEnv.key === undefined) delete process.env.NEXUS_CREDENTIAL_ENC_KEY
  else process.env.NEXUS_CREDENTIAL_ENC_KEY = prevEnv.key
  if (prevEnv.kms === undefined) delete process.env.NEXUS_KMS_KEY_ID
  else process.env.NEXUS_KMS_KEY_ID = prevEnv.kms
  __test.resetKeyCache()
  __cryptoTest.setKmsClient(null)
  __cryptoTest.resetDekCache()
  __cryptoTest.resetFallbackNotice()
  vi.restoreAllMocks()
})

beforeEach(() => {
  process.env.NEXUS_KMS_KEY_ID = ARN_KEY_ID
  fake = new FakeKms()
  __cryptoTest.setKmsClient(fake)
  __cryptoTest.resetDekCache()
  __cryptoTest.resetFallbackNotice()
})

afterEach(() => {
  vi.useRealTimers()
})

describe('encryptCredentials / decryptCredentials — the KMS round trip', () => {
  it('encrypts under a KMS data key and decrypts back to the same object', async () => {
    const res = await encryptCredentials(SAMPLE)
    expect(res.mode).toBe('kms')
    expect(res.keyId).toBe(ARN_KEY_ID)
    expect(res.blob.startsWith('v2:')).toBe(true)
    expect(isCredentialsBlob(res.blob)).toBe(true)
    expect(isEncrypted(res.blob)).toBe(false) // v1-only detector stays v1-only
    expect(await decryptCredentials(res.blob)).toEqual(SAMPLE)
  })

  it('asks KMS for an AES_256 data key under our KeyId and EncryptionContext', async () => {
    await encryptCredentials(SAMPLE)
    expect(fake.generateCalls).toHaveLength(1)
    expect(fake.generateCalls[0].KeyId).toBe(ARN_KEY_ID)
    expect(fake.generateCalls[0].KeySpec).toBe('AES_256')
    expect(fake.generateCalls[0].EncryptionContext).toEqual(EXPECTED_CONTEXT)
  })

  it('has the envelope shape v2:<kid>:<wrappedDek>.<iv>.<tag>.<ct>, all base64url', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { kid, parts } = splitV2(blob)
    expect(parts).toHaveLength(4)
    for (const p of parts) expect(p).toMatch(/^[A-Za-z0-9_-]+$/)
    expect(Buffer.from(parts[1], 'base64url')).toHaveLength(12)
    expect(Buffer.from(parts[2], 'base64url')).toHaveLength(16)
    // An ARN contains ':' so it is carried base64url-encoded with the b64. marker.
    expect(kid.startsWith('b64.')).toBe(true)
    expect(Buffer.from(kid.slice(4), 'base64url').toString('utf8')).toBe(ARN_KEY_ID)
  })

  it('writes a URL-safe KeyId raw, without the b64. marker', async () => {
    fake.keyId = 'mrk-0f3d2a1c7b6e4d5f9a8b1c2d3e4f5a6b'
    const { blob, keyId } = await encryptCredentials(SAMPLE)
    expect(splitV2(blob).kid).toBe(fake.keyId)
    expect(keyId).toBe(fake.keyId)
    expect(credentialsKeyIdOf(blob)).toEqual({ version: 'v2', keyId: fake.keyId })
    expect(await decryptCredentials(blob)).toEqual(SAMPLE)
  })

  it('uses a fresh data key and IV per call, so equal objects never share a blob', async () => {
    const a = await encryptCredentials(SAMPLE)
    const b = await encryptCredentials(SAMPLE)
    expect(a.blob).not.toBe(b.blob)
    expect(splitV2(a.blob).parts[0]).not.toBe(splitV2(b.blob).parts[0])
    expect(fake.generateCalls).toHaveLength(2)
  })

  it('decrypts a v2 blob without NEXUS_KMS_KEY_ID — the wrapped DEK carries its key', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    delete process.env.NEXUS_KMS_KEY_ID
    expect(await decryptCredentials(blob)).toEqual(SAMPLE)
  })

  it('refuses a non-object at encrypt time', async () => {
    await expect(encryptCredentials(null as never)).rejects.toBeInstanceOf(TypeError)
    await expect(encryptCredentials([1, 2] as never)).rejects.toBeInstanceOf(TypeError)
  })
})

describe('the DEK cache', () => {
  it('unwraps once and serves the second decrypt from memory', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    await decryptCredentials(blob)
    expect(fake.decryptCalls).toHaveLength(1)
    await decryptCredentials(blob)
    await decryptCredentials(blob)
    expect(fake.decryptCalls).toHaveLength(1)
  })

  it('goes back to KMS after resetDekCache', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    await decryptCredentials(blob)
    __cryptoTest.resetDekCache()
    await decryptCredentials(blob)
    expect(fake.decryptCalls).toHaveLength(2)
  })

  it('expires an entry after ten minutes', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    await decryptCredentials(blob)
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(Date.now() + 9 * 60 * 1000)
    await decryptCredentials(blob)
    expect(fake.decryptCalls).toHaveLength(1)
    vi.setSystemTime(Date.now() + 2 * 60 * 1000)
    await decryptCredentials(blob)
    expect(fake.decryptCalls).toHaveLength(2)
  })

  it('is bounded at 256 entries, evicting the least recently used', async () => {
    const first = (await encryptCredentials({ i: 0 })).blob
    await decryptCredentials(first)
    for (let i = 1; i <= 256; i++) {
      await decryptCredentials((await encryptCredentials({ i })).blob)
    }
    expect(__cryptoTest.dekCacheSize()).toBe(256)
    const before = fake.decryptCalls.length
    await decryptCredentials(first)
    expect(fake.decryptCalls.length).toBe(before + 1)
  })
})

describe('refusals — every tamper is a CredentialsDecryptError', () => {
  it('tampered ciphertext → auth_tag', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { kid, parts } = splitV2(blob)
    parts[3] = flipByte(parts[3])
    await expectDecryptError(joinV2(kid, parts), 'auth_tag')
  })

  it('tampered auth tag → auth_tag', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { kid, parts } = splitV2(blob)
    parts[2] = flipByte(parts[2])
    await expectDecryptError(joinV2(kid, parts), 'auth_tag')
  })

  it('tampered IV → auth_tag', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { kid, parts } = splitV2(blob)
    parts[1] = flipByte(parts[1])
    await expectDecryptError(joinV2(kid, parts), 'auth_tag')
  })

  it('tampered kid → auth_tag (the kid is authenticated as AAD)', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { kid, parts } = splitV2(blob)
    await expectDecryptError(joinV2(flipChar(kid, kid.length - 1), parts), 'auth_tag')
  })

  it('kid swapped for another key id → auth_tag', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { parts } = splitV2(blob)
    await expectDecryptError(joinV2('mrk-someotherkey', parts), 'auth_tag')
  })

  it('tampered wrapped DEK → kms_unavailable (KMS refuses it)', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    const { kid, parts } = splitV2(blob)
    parts[0] = flipByte(parts[0], 30)
    await expectDecryptError(joinV2(kid, parts), 'kms_unavailable')
  })

  it('wrong EncryptionContext is rejected by KMS → kms_unavailable', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    fake.requiredContext = { app: 'some-other-service', purpose: 'credentials' }
    await expectDecryptError(blob, 'kms_unavailable')
    // …and the context we do send is the one a correctly configured key accepts.
    fake.requiredContext = { ...EXPECTED_CONTEXT }
    expect(await decryptCredentials(blob)).toEqual(SAMPLE)
  })

  it('KMS outage on Decrypt → kms_unavailable, not a raw SDK error', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    __cryptoTest.setKmsClient({ send: async () => { throw kmsError('KMSInternalException', 'down') } } as never)
    await expectDecryptError(blob, 'kms_unavailable')
  })

  it('malformed v2 envelopes → bad_format without touching KMS', async () => {
    await expectDecryptError('v2:', 'bad_format')
    await expectDecryptError('v2:kid', 'bad_format')
    await expectDecryptError('v2:kid:a.b.c', 'bad_format')
    await expectDecryptError('v2:kid:a.b.c.d.e', 'bad_format')
    await expectDecryptError('v2:kid:a..c.d', 'bad_format')
    const iv8 = Buffer.alloc(8).toString('base64url')
    const tag16 = Buffer.alloc(16).toString('base64url')
    await expectDecryptError(`v2:kid:${Buffer.alloc(40).toString('base64url')}.${iv8}.${tag16}.AA`, 'bad_format')
    expect(fake.decryptCalls).toHaveLength(0)
  })

  it('anything that is not a blob → bad_format', async () => {
    await expectDecryptError('{"accessToken":"plain"}', 'bad_format')
    await expectDecryptError('', 'bad_format')
    await expectDecryptError('v3:whatever', 'bad_format')
    await expectDecryptError(undefined as never, 'bad_format')
  })

  it('a v2 blob whose plaintext is not a JSON object → bad_format', async () => {
    // Build a v2 blob by hand around a non-JSON plaintext, using the fake's own wrap.
    const gen = (await fake.send(new (await import('@aws-sdk/client-kms')).GenerateDataKeyCommand({
      KeyId: ARN_KEY_ID, KeySpec: 'AES_256', EncryptionContext: EXPECTED_CONTEXT,
    }))) as { Plaintext: Uint8Array; CiphertextBlob: Uint8Array }
    const kid = 'mrk-handmade'
    const iv = crypto.randomBytes(12)
    const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(gen.Plaintext), iv)
    cipher.setAAD(Buffer.from(`v2:${kid}`))
    const ct = Buffer.concat([cipher.update('not json at all', 'utf8'), cipher.final()])
    const blob = joinV2(kid, [
      Buffer.from(gen.CiphertextBlob).toString('base64url'),
      iv.toString('base64url'),
      cipher.getAuthTag().toString('base64url'),
      ct.toString('base64url'),
    ])
    await expectDecryptError(blob, 'bad_format')
  })
})

describe('v1 blobs keep working through decryptCredentials', () => {
  it('decrypts a v1 envelope written by encryptSecret', async () => {
    const blob = encryptSecret(JSON.stringify(SAMPLE))
    expect(isCredentialsBlob(blob)).toBe(true)
    expect(await decryptCredentials(blob)).toEqual(SAMPLE)
    expect(fake.decryptCalls).toHaveLength(0)
  })

  it('a tampered v1 envelope → auth_tag', async () => {
    const blob = encryptSecret(JSON.stringify(SAMPLE))
    const parts = blob.slice(3).split('.')
    parts[2] = flipByte(parts[2])
    await expectDecryptError(`v1:${parts.join('.')}`, 'auth_tag')
  })

  it('a malformed v1 envelope → bad_format', async () => {
    await expectDecryptError('v1:onlyonepart', 'bad_format')
  })

  it('a v1 envelope around non-JSON → bad_format', async () => {
    await expectDecryptError(encryptSecret('just a string'), 'bad_format')
  })

  it('a missing env key → key_missing', async () => {
    const blob = encryptSecret(JSON.stringify(SAMPLE))
    const saved = process.env.NEXUS_CREDENTIAL_ENC_KEY
    delete process.env.NEXUS_CREDENTIAL_ENC_KEY
    __test.resetKeyCache()
    try {
      await expectDecryptError(blob, 'key_missing')
    } finally {
      process.env.NEXUS_CREDENTIAL_ENC_KEY = saved
      __test.resetKeyCache()
    }
  })
})

describe('fallback to the v1 env key', () => {
  it('writes v1 when NEXUS_KMS_KEY_ID is unset and fires the hook exactly once', async () => {
    delete process.env.NEXUS_KMS_KEY_ID
    const reasons: string[] = []
    onCredentialsKmsFallback((r) => reasons.push(r))

    const a = await encryptCredentials(SAMPLE)
    const b = await encryptCredentials({ other: true })
    expect(a.mode).toBe('env')
    expect(a.keyId).toBe('env')
    expect(a.blob.startsWith('v1:')).toBe(true)
    expect(b.mode).toBe('env')
    expect(fake.generateCalls).toHaveLength(0)
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/NEXUS_KMS_KEY_ID/)
    expect(await decryptCredentials(a.blob)).toEqual(SAMPLE)
  })

  it('falls back when KMS throws on GenerateDataKey, hook once, decrypt still fine', async () => {
    fake.failGenerate = true
    const reasons: string[] = []
    onCredentialsKmsFallback((r) => reasons.push(r))
    const a = await encryptCredentials(SAMPLE)
    const b = await encryptCredentials(SAMPLE)
    expect(a.mode).toBe('env')
    expect(b.mode).toBe('env')
    expect(reasons).toHaveLength(1)
    expect(reasons[0]).toMatch(/GenerateDataKey/)
    expect(fake.generateCalls).toHaveLength(2) // it kept trying KMS; only the notice is once
    expect(await decryptCredentials(a.blob)).toEqual(SAMPLE)
  })

  it('tells a hook registered after the fallback already happened', async () => {
    delete process.env.NEXUS_KMS_KEY_ID
    await encryptCredentials(SAMPLE)
    const reasons: string[] = []
    onCredentialsKmsFallback((r) => reasons.push(r))
    expect(reasons).toHaveLength(1)
  })

  it('does not fire the hook when KMS works', async () => {
    const reasons: string[] = []
    onCredentialsKmsFallback((r) => reasons.push(r))
    await encryptCredentials(SAMPLE)
    expect(reasons).toHaveLength(0)
  })

  it('a hook that throws does not break encryption', async () => {
    delete process.env.NEXUS_KMS_KEY_ID
    onCredentialsKmsFallback(() => { throw new Error('alert service down') })
    const res = await encryptCredentials(SAMPLE)
    expect(res.mode).toBe('env')
  })
})

describe('reencryptCredentials — the rotation job primitive', () => {
  it('moves a v1 blob to v2 once KMS is configured', async () => {
    const v1 = encryptSecret(JSON.stringify(SAMPLE))
    const res = await reencryptCredentials(v1)
    expect(res.mode).toBe('kms')
    expect(credentialsKeyIdOf(res.blob)).toEqual({ version: 'v2', keyId: ARN_KEY_ID })
    expect(await decryptCredentials(res.blob)).toEqual(SAMPLE)
  })

  it('re-wraps a v2 blob under the current key as a new blob with the same contents', async () => {
    const first = await encryptCredentials(SAMPLE)
    fake.keyId = 'arn:aws:kms:eu-west-1:123456789012:key/rotated-0000-0000-0000-000000000000'
    const res = await reencryptCredentials(first.blob)
    expect(res.blob).not.toBe(first.blob)
    expect(res.keyId).toBe(fake.keyId)
    expect(credentialsKeyIdOf(res.blob).keyId).toBe(fake.keyId)
    expect(await decryptCredentials(res.blob)).toEqual(SAMPLE)
    expect(await decryptCredentials(first.blob)).toEqual(SAMPLE) // the old row still reads
  })

  it('surfaces the decrypt error when the source blob is bad', async () => {
    await expect(reencryptCredentials('v2:kid:a.b.c')).rejects.toBeInstanceOf(CredentialsDecryptError)
  })
})

describe('credentialsKeyIdOf / isCredentialsBlob', () => {
  it('reports v1 with no key id', () => {
    expect(credentialsKeyIdOf(encryptSecret('{}'))).toEqual({ version: 'v1', keyId: null })
  })

  it('reports v2 with the decoded KMS KeyId', async () => {
    const { blob } = await encryptCredentials(SAMPLE)
    expect(credentialsKeyIdOf(blob)).toEqual({ version: 'v2', keyId: ARN_KEY_ID })
  })

  it('throws bad_format on anything else', () => {
    expect(() => credentialsKeyIdOf('plain')).toThrow(CredentialsDecryptError)
    expect(() => credentialsKeyIdOf('v2:broken')).toThrow(CredentialsDecryptError)
  })

  it('isCredentialsBlob is true for v1 and v2, false otherwise', async () => {
    expect(isCredentialsBlob(encryptSecret('{}'))).toBe(true)
    expect(isCredentialsBlob((await encryptCredentials(SAMPLE)).blob)).toBe(true)
    expect(isCredentialsBlob('{"a":1}')).toBe(false)
    expect(isCredentialsBlob('')).toBe(false)
    expect(isCredentialsBlob(null)).toBe(false)
    expect(isCredentialsBlob(42)).toBe(false)
  })
})

describe('errors carry no key material', () => {
  const SENTINEL = 'sk_live_THIS_MUST_NEVER_APPEAR_9f8e7d6c'

  function dekForms(dek: Buffer): string[] {
    return [dek.toString('hex'), dek.toString('base64'), dek.toString('base64url')]
  }

  function expectClean(err: CredentialsDecryptError, blob: string): void {
    const rendered = [JSON.stringify(err), err.message, String(err), err.stack ?? '']
    const forbidden = [SENTINEL, ...(fake.lastDek ? dekForms(fake.lastDek) : []), splitV2(blob).parts[3]]
    for (const text of rendered) {
      for (const secret of forbidden) expect(text).not.toContain(secret)
    }
    expect(JSON.parse(JSON.stringify(err))).toEqual({ name: 'CredentialsDecryptError', code: err.code, message: err.message })
  }

  it('after a GCM failure', async () => {
    const { blob } = await encryptCredentials({ clientSecret: SENTINEL })
    const { kid, parts } = splitV2(blob)
    parts[3] = flipByte(parts[3])
    const err = await expectDecryptError(joinV2(kid, parts), 'auth_tag')
    expectClean(err, blob)
  })

  it('after a KMS refusal', async () => {
    const { blob } = await encryptCredentials({ clientSecret: SENTINEL })
    fake.requiredContext = { app: 'other', purpose: 'credentials' }
    const err = await expectDecryptError(blob, 'kms_unavailable')
    expectClean(err, blob)
  })
})
