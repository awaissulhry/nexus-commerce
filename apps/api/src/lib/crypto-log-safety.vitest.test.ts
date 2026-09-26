import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { FakeKms } from '../test-support/fake-kms.js'
import { logger } from '../utils/logger.js'
import { __cryptoTest, __test, decryptCredentials, encryptCredentials, onCredentialsKmsFallback } from './crypto.js'

const privateValue = 'synthetic-private-provider-response'
let fake: FakeKms
beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
  __test.resetKeyCache(); __cryptoTest.resetDekCache(); __cryptoTest.resetFallbackNotice()
  fake = new FakeKms(); __cryptoTest.setKmsClient(fake as never)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })
it.each([new Error(privateValue), Object.assign(new Error('failed'), { name: privateValue }), privateValue])('never logs arbitrary provider exception content', async error => {
  const { blob } = await encryptCredentials({ token: 'synthetic' }), warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {})
  vi.spyOn(fake, 'send').mockRejectedValue(error)
  await expect(decryptCredentials(blob)).rejects.toMatchObject({ code: 'kms_unavailable' })
  expect(warnings).toHaveBeenCalled()
  expect(JSON.stringify(warnings.mock.calls)).not.toContain(privateValue)
})
it('retains a known failure class while removing provider messages from logs and fallback notifications', async () => {
  const error = Object.assign(new Error(privateValue), { name: 'AccessDeniedException' })
  const warnings = vi.spyOn(logger, 'warn').mockImplementation(() => {}), fallback = vi.fn(), unsubscribe = onCredentialsKmsFallback(fallback)
  try {
    vi.spyOn(fake, 'send').mockRejectedValue(error)
    expect(await encryptCredentials({ token: 'synthetic' })).toMatchObject({ mode: 'env' })
    const observed = JSON.stringify([warnings.mock.calls, fallback.mock.calls])
    expect(observed).toContain('AccessDeniedException')
    expect(observed).not.toContain(privateValue)
  } finally { unsubscribe() }
})
