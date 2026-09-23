import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { createHash, randomBytes } from 'node:crypto'
import { FakeKms, FAKE_KMS_KEY_ID } from '../../../test-support/fake-kms.js'
import { __cryptoTest, __test, decryptCredentials, encryptCredentials } from '../../../lib/crypto.js'
import { openEbayQuarantineBody, reencryptEbayQuarantine, type QuarantineCipher } from './ebay-quarantine-crypto.js'

let kms: FakeKms
beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64'))
  vi.stubEnv('NEXUS_KMS_KEY_ID', '')
  __test.resetKeyCache(); __cryptoTest.resetDekCache()
  kms = new FakeKms(); __cryptoTest.setKmsClient(kms as never)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
const hash = (raw: Buffer) => createHash('sha256').update(raw).digest('hex')
async function fixture(rawBody = Buffer.from('{"unsupported":"synthetic-private-body"}')) {
  const binding = { environment: 'production', signatureOk: true, externalId: 'synthetic-notice', topic: 'FUTURE_TOPIC', subjectHash: null, payloadDigest: hash(rawBody) }
  const sealed = { version: 1, binding, rawBody: rawBody.toString('base64'), header: 'synthetic-original-signature' }
  const encrypted = await encryptCredentials(sealed)
  return { row: { ...binding, payloadEnc: encrypted.blob, payloadKeyId: encrypted.keyId } satisfies QuarantineCipher, sealed, rawBody }
}

it.each([Buffer.from('{"unsupported":"synthetic-private-body"}'), Buffer.from('verified but malformed JSON'), Buffer.from([0, 255, 128, 10])])('retains verified bytes without requiring an adoptable schema', async rawBody => {
  const { row, sealed } = await fixture(rawBody), before = structuredClone(row)
  const replacement = await reencryptEbayQuarantine(row, FAKE_KMS_KEY_ID)
  expect(await openEbayQuarantineBody({ ...row, payloadEnc: replacement.blob, payloadKeyId: replacement.keyId })).toEqual(rawBody)
  expect(await decryptCredentials(replacement.blob)).toEqual(sealed)
  expect(replacement).toMatchObject({ mode: 'kms', keyId: FAKE_KMS_KEY_ID })
  expect(row).toEqual(before)
})

it.each([
  ['environment', 'sandbox'], ['externalId', 'different-notice'], ['topic', 'AUTHORIZATION_REVOCATION'],
  ['subjectHash', 'a'.repeat(64)], ['payloadDigest', 'b'.repeat(64)],
] as const)('rejects a sealed body transplanted to a different %s', async (key, value) => {
  const { row } = await fixture()
  await expect(reencryptEbayQuarantine({ ...row, [key]: value }, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'quarantine_cipher_invalid' })
  expect(kms.generateCalls).toHaveLength(0)
})

it.each([
  { signatureOk: false }, { payloadEnc: null }, { payloadKeyId: null },
  { payloadKeyId: FAKE_KMS_KEY_ID }, { environment: 'unknown' },
])('refuses rejected, missing or inconsistent envelope metadata: %j', async changed => {
  const { row } = await fixture()
  await expect(reencryptEbayQuarantine({ ...row, ...changed }, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'quarantine_cipher_invalid' })
  expect(kms.generateCalls).toHaveLength(0)
})

it.each(['changed-body', 'bad-base64', 'empty', 'oversized', 'version', 'binding-array'])('refuses authenticated but invalid sealed contents: %s', async corruption => {
  const { row, sealed } = await fixture()
  const changed: Record<string, unknown> = { ...sealed }
  if (corruption === 'changed-body') changed.rawBody = Buffer.from('changed').toString('base64')
  if (corruption === 'bad-base64') changed.rawBody = `${sealed.rawBody}\n`
  if (corruption === 'empty') changed.rawBody = ''
  if (corruption === 'oversized') changed.rawBody = Buffer.alloc(1_048_577).toString('base64')
  if (corruption === 'version') changed.version = 2
  if (corruption === 'binding-array') changed.binding = []
  const encrypted = await encryptCredentials(changed)
  await expect(reencryptEbayQuarantine({ ...row, payloadEnc: encrypted.blob }, FAKE_KMS_KEY_ID)).rejects.toMatchObject({ code: 'quarantine_cipher_invalid' })
  expect(kms.generateCalls).toHaveLength(0)
})

it('does not let cached old-key access certify recoverability', async () => {
  vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
  const { row } = await fixture()
  await openEbayQuarantineBody(row)
  const send = kms.send.bind(kms)
  vi.spyOn(kms, 'send').mockImplementation(async command => {
    if (command.constructor.name === 'DecryptCommand') throw new Error('Synthetic provider body must not be exposed')
    return send(command)
  })
  const error = await reencryptEbayQuarantine(row, FAKE_KMS_KEY_ID).catch(error => error)
  expect(error).toMatchObject({ code: 'quarantine_cipher_invalid' })
  expect(String(error)).not.toContain('Synthetic provider body')
  expect(kms.generateCalls).toHaveLength(1) // original only
})

it('rejects KMS metadata that disagrees with the authenticated envelope', async () => {
  vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
  const { row } = await fixture()
  await expect(openEbayQuarantineBody({ ...row, payloadKeyId: FAKE_KMS_KEY_ID.replace('0f3d2a1c', '1f3d2a1c') })).rejects.toMatchObject({ code: 'quarantine_cipher_invalid' })
})

it.each([undefined, null, '', 'env', 'alias/test'])('refuses a missing or unresolved strict target %s before opening the source', async target => {
  vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
  const { row } = await fixture()
  kms.generateCalls = []
  await expect(reencryptEbayQuarantine(row, target as never)).rejects.toMatchObject({ code: 'target_invalid' })
  expect(kms.generateCalls).toHaveLength(0)
  expect(kms.decryptCalls).toHaveLength(0)
})
