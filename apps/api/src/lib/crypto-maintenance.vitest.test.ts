import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { FakeKms, FAKE_KMS_KEY_ID } from '../test-support/fake-kms.js'
import { __cryptoTest, __test, encryptCredentials, encryptSecret, decryptCredentials, reencryptCredentials, onCredentialsKmsFallback } from './crypto.js'

let fake: FakeKms
beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/current')
  __test.resetKeyCache(); __cryptoTest.resetDekCache(); __cryptoTest.resetFallbackNotice()
  fake = new FakeKms(); __cryptoTest.setKmsClient(fake as never)
})
afterEach(() => vi.unstubAllEnvs())

it('pins the outgoing GenerateDataKey request to the resolved resource, not a mutable alias', async () => {
  const old = encryptSecret(JSON.stringify({ token: 'synthetic-original' }))
  const result = await reencryptCredentials(old, FAKE_KMS_KEY_ID)
  expect(fake.generateCalls.map(call => call.KeyId)).toEqual([FAKE_KMS_KEY_ID])
  expect(result).toMatchObject({ mode: 'kms', keyId: FAKE_KMS_KEY_ID })
  expect(await decryptCredentials(result.blob)).toEqual({ token: 'synthetic-original' })
})
it('preserves valid JSON values that would change under parse-and-stringify normalization', async () => {
  const old = encryptSecret('{"signedZero":-0,"token":"synthetic-original"}')
  const result = await reencryptCredentials(old, FAKE_KMS_KEY_ID)
  expect(Object.is((await decryptCredentials(result.blob)).signedZero, -0)).toBe(true)
})
it('never uses env fallback during strict maintenance', async () => {
  const old = encryptSecret(JSON.stringify({ token: 'synthetic-original' })), fallback = vi.fn()
  onCredentialsKmsFallback(fallback); fake.failGenerate = true
  await expect(reencryptCredentials(old, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'kms_encrypt_failed' })
  expect(fallback).not.toHaveBeenCalled()
  expect(await decryptCredentials(old)).toEqual({ token: 'synthetic-original' })
})
it('refuses a provider response naming a different target key', async () => {
  const old = encryptSecret(JSON.stringify({ token: 'synthetic-original' }))
  fake.keyId = FAKE_KMS_KEY_ID.replace('0f3d2a1c', '1f3d2a1c')
  await expect(reencryptCredentials(old, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'target_changed' })
})
it('does not let a warm cache conceal revoked old-key access during maintenance', async () => {
  fake.keyId = FAKE_KMS_KEY_ID.replace('0f3d2a1c', '1f3d2a1c')
  const { blob } = await encryptCredentials({ token: 'synthetic-original' })
  await decryptCredentials(blob)
  const oldWrappedDek = blob.slice(blob.indexOf(':', 3) + 1).split('.')[0]
  fake.keyId = FAKE_KMS_KEY_ID
  const original = fake.send.bind(fake)
  vi.spyOn(fake, 'send').mockImplementation(async command => {
    if (command.constructor.name === 'DecryptCommand' && Buffer.from(command.input.CiphertextBlob ?? []).toString('base64url') === oldWrappedDek) {
      throw new Error('Synthetic old-key decrypt permission removed')
    }
    return original(command)
  })
  expect(await decryptCredentials(blob)).toEqual({ token: 'synthetic-original' })
  await expect(reencryptCredentials(blob, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'kms_unavailable' })
})
it('cold-verifies the replacement and returns no envelope if target decrypt is denied', async () => {
  const old = encryptSecret(JSON.stringify({ token: 'synthetic-original' })), original = fake.send.bind(fake)
  vi.spyOn(fake, 'send').mockImplementation(async command => {
    if (command.constructor.name === 'DecryptCommand') throw new Error('Synthetic target decrypt denied')
    return original(command)
  })
  await expect(reencryptCredentials(old, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'kms_unavailable' })
})
it.each(['alias/current', 'env', '', 'not-an-arn'])('refuses an unresolved maintenance target %s before any crypto request', async target => {
  const old = encryptSecret('{}')
  await expect(reencryptCredentials(old, target)).rejects.toMatchObject({ code: 'target_invalid' })
  expect(fake.generateCalls).toHaveLength(0)
  expect(fake.decryptCalls).toHaveLength(0)
})
it('opens the same uncached envelope concurrently without one cache insertion erasing another reader’s key', async () => {
  const { blob } = await encryptCredentials({ token: 'synthetic-concurrent' })
  expect(await Promise.all([decryptCredentials(blob), decryptCredentials(blob)])).toEqual([{ token: 'synthetic-concurrent' }, { token: 'synthetic-concurrent' }])
})
it('keeps an in-flight cached reader valid when the cache is cleared', async () => {
  const { blob } = await encryptCredentials({ token: 'synthetic-cached' })
  await decryptCredentials(blob)
  const reading = decryptCredentials(blob)
  __cryptoTest.resetDekCache()
  expect(await reading).toEqual({ token: 'synthetic-cached' })
})
