import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { DecryptCommand, GenerateDataKeyCommand } from '@aws-sdk/client-kms'
import { describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { EncryptionContext } from '@nexus/factory-domain/ports/kms'
import { parseFactoryEnv } from '../../env'
import { awsKmsKeyProvider, type KmsClientLike } from './aws-kms'
import { createSecretsService, SecretError, unconfiguredSecrets, type SealedSecret, type SecretContext } from './envelope'
import { LocalKeyRefusedError, localKeyProvider } from './local'
import { secretsFromEnv } from './service'

// The envelope encryption of platform/secrets, without a database and without AWS: every key is generated here, and
// the KMS provider runs against a fake client that behaves like KMS (it keeps each data key with its context).

const key = () => randomBytes(32)
const local = (masterKey = key()) => localKeyProvider({ masterKey, environment: 'test' })
const tenantA = newId()
const tenantB = newId()
const CREDENTIALS: SecretContext = { tenantId: tenantA, purpose: 'integration.credentials' }
const VALUE = '{"apiKey":"sk_test_made_up_value_123"}'

const flip = (bytes: Uint8Array, at = 0): Uint8Array => {
  const copy = Uint8Array.from(bytes)
  copy[at] = copy[at]! ^ 0x01
  return copy
}

/** A stand-in for AWS KMS: GenerateDataKey and Decrypt with the encryption context, all in memory. */
function fakeKms(arn = 'arn:aws:kms:eu-south-1:000000000000:key/11111111-2222-3333-4444-555555555555') {
  const master = key()
  const calls: { command: string; input: Record<string, unknown> }[] = []
  const aad = (context: EncryptionContext | undefined) => Buffer.from(JSON.stringify(Object.entries(context ?? {}).sort()))
  const client = {
    async send(command: GenerateDataKeyCommand | DecryptCommand) {
      calls.push({ command: command.constructor.name, input: { ...command.input } })
      if (command instanceof GenerateDataKeyCommand) {
        const plaintext = randomBytes(32)
        const iv = randomBytes(12)
        const cipher = createCipheriv('aes-256-gcm', master, iv)
        cipher.setAAD(aad(command.input.EncryptionContext))
        const body = Buffer.concat([cipher.update(plaintext), cipher.final()])
        return { KeyId: arn, Plaintext: plaintext, CiphertextBlob: Buffer.concat([iv, cipher.getAuthTag(), body]) }
      }
      const blob = Buffer.from(command.input.CiphertextBlob!)
      const decipher = createDecipheriv('aes-256-gcm', master, blob.subarray(0, 12))
      decipher.setAAD(aad(command.input.EncryptionContext))
      decipher.setAuthTag(blob.subarray(12, 28))
      try {
        return { KeyId: arn, Plaintext: Buffer.concat([decipher.update(blob.subarray(28)), decipher.final()]) }
      } catch {
        const error = new Error('The ciphertext refers to a customer master key that does not exist or the context does not match.')
        error.name = 'InvalidCiphertextException'
        throw error
      }
    },
  } as unknown as KmsClientLike
  return { client, calls, arn }
}

describe('seal and open (AES-256-GCM, a data key per value)', () => {
  it('opens what it sealed, and never stores the plaintext or the plain data key', async () => {
    const secrets = createSecretsService({ providers: [local()] })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    expect(sealed.algorithm).toBe('AES-256-GCM')
    expect(sealed.keyId).toMatch(/^local:[0-9a-f]{16}$/)
    expect(sealed.iv).toHaveLength(12)
    expect(sealed.authTag).toHaveLength(16)
    expect(sealed.wrappedKey).toHaveLength(60)
    expect(Buffer.from(sealed.ciphertext).toString('utf8')).not.toContain('sk_test')
    expect(await secrets.open(sealed, CREDENTIALS)).toBe(VALUE)
    // A new data key and nonce every time: the same value never seals the same way twice.
    const again = await secrets.seal(VALUE, CREDENTIALS)
    expect(Buffer.from(again.ciphertext).equals(Buffer.from(sealed.ciphertext))).toBe(false)
    expect(Buffer.from(again.wrappedKey).equals(Buffer.from(sealed.wrappedKey))).toBe(false)
  })

  it.each<[string, SecretContext]>([
    ['another tenant', { tenantId: tenantB, purpose: 'integration.credentials' }],
    ['another purpose', { tenantId: tenantA, purpose: 'integration.webhook' }],
    ['no tenant (platform)', { tenantId: null, purpose: 'integration.credentials' }],
  ])('refuses to open with %s (wrong AAD)', async (_label, context) => {
    const secrets = createSecretsService({ providers: [local()], cacheMs: 0 })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    await expect(secrets.open(sealed, context)).rejects.toThrow(SecretError)
  })

  it('refuses the wrong AAD even when the data key is already unwrapped (cached)', async () => {
    const secrets = createSecretsService({ providers: [local()] })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    expect(await secrets.open(sealed, CREDENTIALS)).toBe(VALUE)
    await expect(secrets.open(sealed, { tenantId: tenantB, purpose: CREDENTIALS.purpose })).rejects.toThrow(SecretError)
  })

  it.each<[string, (sealed: SealedSecret) => SealedSecret]>([
    ['a changed ciphertext', (sealed) => ({ ...sealed, ciphertext: flip(sealed.ciphertext) })],
    ['a changed tag', (sealed) => ({ ...sealed, authTag: flip(sealed.authTag) })],
    ['a changed nonce', (sealed) => ({ ...sealed, iv: flip(sealed.iv) })],
    ['a changed wrapped key', (sealed) => ({ ...sealed, wrappedKey: flip(sealed.wrappedKey, 40) })],
    ['another key id', (sealed) => ({ ...sealed, keyId: 'local:0000000000000000' })],
    ['another algorithm', (sealed) => ({ ...sealed, algorithm: 'AES-128-CBC' as never })],
  ])('refuses %s (tampering)', async (_label, tamper) => {
    const secrets = createSecretsService({ providers: [local()], cacheMs: 0 })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    await expect(secrets.open(tamper(sealed), CREDENTIALS)).rejects.toThrow(SecretError)
  })

  it('never puts the value in an error message', async () => {
    const secrets = createSecretsService({ providers: [local()], cacheMs: 0 })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    const error = await secrets.open({ ...sealed, ciphertext: flip(sealed.ciphertext) }, CREDENTIALS).catch((caught: Error) => caught)
    expect(String((error as Error).message)).not.toContain('sk_test')
  })

  it('refuses a context without a purpose, or with a tenant that is not a UUID', async () => {
    const secrets = createSecretsService({ providers: [local()] })
    await expect(secrets.seal(VALUE, { tenantId: tenantA, purpose: 'credentials' })).rejects.toThrow(/purpose/)
    await expect(secrets.seal(VALUE, { tenantId: 'tenant-a', purpose: 'integration.credentials' })).rejects.toThrow(/UUID/)
  })

  it('the string form round-trips, and refuses a malformed or changed string', async () => {
    const secrets = createSecretsService({ providers: [local()], cacheMs: 0 })
    const text = await secrets.sealToString(VALUE, { tenantId: tenantA, purpose: 'auth.totp' })
    expect(text).toMatch(/^s1(\.[A-Za-z0-9_-]+){5}$/)
    expect(await secrets.openString(text, { tenantId: tenantA, purpose: 'auth.totp' })).toBe(VALUE)
    await expect(secrets.openString('l1.abc.def.ghi', { tenantId: tenantA, purpose: 'auth.totp' })).rejects.toThrow(/Not a sealed secret string/)
    const parts = text.split('.')
    parts[4] = Buffer.from(flip(Buffer.from(parts[4]!, 'base64url'))).toString('base64url')
    await expect(secrets.openString(parts.join('.'), { tenantId: tenantA, purpose: 'auth.totp' })).rejects.toThrow(SecretError)
  })
})

describe('key ids and rotation', () => {
  it('re-seals under the current key; the old key may then go', async () => {
    const oldKey = local()
    const newKey = local()
    const before = createSecretsService({ providers: [oldKey] })
    const sealed = await before.seal(VALUE, CREDENTIALS)
    const during = createSecretsService({ providers: [newKey, oldKey] })
    expect(during.needsRotation(sealed)).toBe(true)
    const rotated = await during.rotate(sealed, CREDENTIALS)
    expect(rotated.keyId).toBe(newKey.keyId)
    expect(during.needsRotation(rotated)).toBe(false)
    const after = createSecretsService({ providers: [newKey] })
    expect(await after.open(rotated, CREDENTIALS)).toBe(VALUE)
    await expect(after.open(sealed, CREDENTIALS)).rejects.toThrow(/No key provider holds key local:/)
    const text = await before.sealToString(VALUE, CREDENTIALS)
    expect(await after.openString(await during.rotateString(text, CREDENTIALS), CREDENTIALS)).toBe(VALUE)
  })

  it('names each local master key by its fingerprint', () => {
    const master = key()
    expect(local(master).keyId).toBe(local(Buffer.from(master)).keyId)
    expect(local().keyId).not.toBe(local(master).keyId)
  })
})

describe('the local key provider', () => {
  it.each(['staging', 'production'] as const)('is refused with FACTORY_ENV=%s', (environment) => {
    expect(() => localKeyProvider({ masterKey: key(), environment })).toThrow(LocalKeyRefusedError)
  })

  it('refuses a master key that is not 32 bytes', () => {
    expect(() => localKeyProvider({ masterKey: randomBytes(16), environment: 'test' })).toThrow(/32 bytes/)
  })

  it('is what the env gives local and test runs; without a key every seal is refused with the reason', async () => {
    const base = { FACTORY_ENV: 'test', FACTORY_DATABASE_URL: 'postgresql://factory_app@127.0.0.1:5442/factory_test_x', FACTORY_REDIS_URL: 'redis://127.0.0.1:6399', FACTORY_QUEUE_PREFIX: 'w0_18' }
    const withKey = secretsFromEnv(parseFactoryEnv({ ...base, FACTORY_SECRETS_MASTER_KEY: key().toString('base64') }, undefined))
    expect(withKey.keyId).toMatch(/^local:/)
    expect(await withKey.open(await withKey.seal(VALUE, CREDENTIALS), CREDENTIALS)).toBe(VALUE)
    const without = secretsFromEnv(parseFactoryEnv(base, undefined))
    await expect(without.seal(VALUE, CREDENTIALS)).rejects.toThrow(/FACTORY_SECRETS_MASTER_KEY is not set/)
    await expect(unconfiguredSecrets('off').open({} as SealedSecret, CREDENTIALS)).rejects.toThrow('off')
  })
})

describe('the AWS KMS key provider (a fake client: nothing reaches AWS)', () => {
  it('wraps with GenerateDataKey and unwraps with Decrypt, both with the encryption context', async () => {
    const kms = fakeKms()
    const secrets = createSecretsService({ providers: [awsKmsKeyProvider({ client: kms.client, keyId: kms.arn })], cacheMs: 0 })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    expect(sealed.keyId).toBe(`kms:${kms.arn}`)
    expect(secrets.needsRotation(sealed)).toBe(false)
    expect(await secrets.open(sealed, CREDENTIALS)).toBe(VALUE)
    const context = { app: 'nexus-factory', tenant: tenantA, purpose: 'integration.credentials' }
    expect(kms.calls).toEqual([
      { command: 'GenerateDataKeyCommand', input: { KeyId: kms.arn, KeySpec: 'AES_256', EncryptionContext: context } },
      { command: 'DecryptCommand', input: expect.objectContaining({ KeyId: kms.arn, EncryptionContext: context }) },
    ])
  })

  it('refuses another context (KMS refuses the unwrap), and a value sealed by another provider', async () => {
    const kms = fakeKms()
    const secrets = createSecretsService({ providers: [awsKmsKeyProvider({ client: kms.client, keyId: kms.arn })], cacheMs: 0 })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    await expect(secrets.open(sealed, { tenantId: tenantB, purpose: CREDENTIALS.purpose })).rejects.toThrow(/did not unwrap/)
    const localSealed = await createSecretsService({ providers: [local()] }).seal(VALUE, CREDENTIALS)
    await expect(secrets.open(localSealed, CREDENTIALS)).rejects.toThrow(/No key provider holds key local:/)
  })

  it('caches an unwrapped data key, so a second open does not call KMS again', async () => {
    const kms = fakeKms()
    const secrets = createSecretsService({ providers: [awsKmsKeyProvider({ client: kms.client, keyId: kms.arn })] })
    const sealed = await secrets.seal(VALUE, CREDENTIALS)
    await secrets.open(sealed, CREDENTIALS)
    await secrets.open(sealed, CREDENTIALS)
    expect(kms.calls.filter((call) => call.command === 'DecryptCommand')).toHaveLength(1)
  })

  it('moves local values to KMS with the rotation helper', async () => {
    const kms = fakeKms()
    const before = local()
    const sealed = await createSecretsService({ providers: [before] }).seal(VALUE, CREDENTIALS)
    const moving = createSecretsService({ providers: [awsKmsKeyProvider({ client: kms.client, keyId: kms.arn }), before] })
    const rotated = await moving.rotate(sealed, CREDENTIALS)
    expect(rotated.keyId).toBe(`kms:${kms.arn}`)
    expect(await createSecretsService({ providers: [awsKmsKeyProvider({ client: kms.client, keyId: kms.arn })] }).open(rotated, CREDENTIALS)).toBe(VALUE)
  })

  it('is what the env gives production (made, never called here)', () => {
    const secrets = secretsFromEnv(
      parseFactoryEnv(
        {
          FACTORY_ENV: 'production',
          FACTORY_DATABASE_URL: 'postgresql://factory_app@db.example.com:5432/factory',
          FACTORY_REDIS_URL: 'redis://cache.example.com:6379',
          FACTORY_WEB_ORIGIN: 'https://factory.example.com',
          FACTORY_COOKIE_SECRET: 'a-random-secret-of-at-least-thirty-two-chars',
          FACTORY_KMS_KEY_ID: 'arn:aws:kms:eu-south-1:000000000000:key/made-up',
          FACTORY_AWS_ACCESS_KEY_ID: 'AKIAEXAMPLEEXAMPLE00',
          FACTORY_AWS_SECRET_ACCESS_KEY: 'not-a-real-secret-access-key-for-tests',
        },
        'production',
      ),
    )
    expect(secrets.keyId).toBe('kms:arn:aws:kms:eu-south-1:000000000000:key/made-up')
  })
})
