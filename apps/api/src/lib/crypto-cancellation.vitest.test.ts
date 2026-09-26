import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:http'
import { KMSClient } from '@aws-sdk/client-kms'
import { FakeKms, FAKE_KMS_KEY_ID } from '../test-support/fake-kms.js'
import { __cryptoTest, __test, decryptCredentials, encryptCredentials, encryptSecret, reencryptCredentials } from './crypto.js'

let fake: FakeKms
beforeEach(() => {
  vi.stubEnv('NEXUS_CREDENTIAL_ENC_KEY', randomBytes(32).toString('base64')); vi.stubEnv('NEXUS_KMS_KEY_ID', 'alias/test')
  __test.resetKeyCache(); __cryptoTest.resetDekCache()
  fake = new FakeKms(); __cryptoTest.setKmsClient(fake as never)
})
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs() })

it('refuses a cancelled env-source rewrap before requesting a replacement key', async () => {
  const controller = new AbortController(), source = encryptSecret('{"token":"synthetic"}')
  controller.abort('private cancellation reason')
  await expect(reencryptCredentials(source, FAKE_KMS_KEY_ID, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  expect(fake.generateCalls).toHaveLength(0)
})
it('honors cancellation on a warm cached read without damaging other readers', async () => {
  const { blob } = await encryptCredentials({ token: 'synthetic' })
  await decryptCredentials(blob)
  const controller = new AbortController(); controller.abort('private cancellation reason')
  const error = await decryptCredentials(blob, { signal: controller.signal }).catch(error => error)
  expect(error).toMatchObject({ code: 'cancelled' }); expect(String(error)).not.toContain('private cancellation reason')
  expect(await decryptCredentials(blob)).toEqual({ token: 'synthetic' })
})
it('wipes only the cancelled in-flight cached reader’s copy', async () => {
  const { blob } = await encryptCredentials({ token: 'synthetic' })
  await decryptCredentials(blob)
  const controller = new AbortController(), reading = decryptCredentials(blob, { signal: controller.signal })
  controller.abort()
  await expect(reading).rejects.toMatchObject({ code: 'cancelled' })
  expect(await decryptCredentials(blob)).toEqual({ token: 'synthetic' })
})
it('refuses a signal-bearing maintenance call with no pinned target instead of choosing legacy fallback', async () => {
  const controller = new AbortController(), source = encryptSecret('{}')
  await expect(reencryptCredentials(source, undefined, { signal: controller.signal })).rejects.toMatchObject({ code: 'target_invalid' })
  expect(fake.generateCalls).toHaveLength(0)
})
it('discards and wipes a generated key returned after cancellation', async () => {
  const controller = new AbortController(), source = encryptSecret('{}'), send = fake.send.bind(fake)
  let returned: Uint8Array | undefined
  vi.spyOn(fake, 'send').mockImplementation(async command => {
    const response = await send(command) as { Plaintext: Uint8Array }
    if (command.constructor.name === 'GenerateDataKeyCommand') { returned = response.Plaintext; controller.abort() }
    return response
  })
  await expect(reencryptCredentials(source, FAKE_KMS_KEY_ID, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  expect(returned && Buffer.from(returned).every(byte => byte === 0)).toBe(true)
})
it('does not cache a decrypted key returned after cancellation', async () => {
  const { blob } = await encryptCredentials({ token: 'synthetic' }), controller = new AbortController(), send = fake.send.bind(fake)
  let returned: Uint8Array | undefined
  vi.spyOn(fake, 'send').mockImplementation(async command => {
    const response = await send(command) as { Plaintext: Uint8Array }
    if (command.constructor.name === 'DecryptCommand') { returned = response.Plaintext; controller.abort() }
    return response
  })
  await expect(decryptCredentials(blob, { signal: controller.signal })).rejects.toMatchObject({ code: 'cancelled' })
  expect(returned && Buffer.from(returned).every(byte => byte === 0)).toBe(true)
  vi.restoreAllMocks()
  await decryptCredentials(blob)
  expect(fake.decryptCalls).toHaveLength(2)
})
it.each(['source', 'replacement'])('aborts a real SDK HTTP request for the %s using a loopback-only synthetic KMS endpoint', async phase => {
  const source = phase === 'source' ? (await encryptCredentials({ token: 'synthetic' })).blob : encryptSecret('{}')
  const controller = new AbortController()
  let received!: () => void, closed!: () => void
  const arrived = new Promise<void>(resolve => { received = resolve }), disconnected = new Promise<void>(resolve => { closed = resolve })
  const server = createServer((request, response) => { request.resume(); response.once('close', closed); received() })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('Expected loopback listener')
  const sdk = new KMSClient({ region: 'eu-west-1', maxAttempts: 1, endpoint: `http://127.0.0.1:${address.port}`,
    credentials: { accessKeyId: 'synthetic-local-test', secretAccessKey: 'synthetic-local-test' } })
  __cryptoTest.setKmsClient(sdk)
  let cleanupTimer: ReturnType<typeof setTimeout> | undefined, arrivalTimer: ReturnType<typeof setTimeout> | undefined, forcedClose = false
  try {
    const result = reencryptCredentials(source, FAKE_KMS_KEY_ID, { signal: controller.signal }).catch(error => error)
    await Promise.race([
      arrived,
      result.then(() => { throw new Error('Crypto settled before reaching the loopback endpoint') }),
      new Promise<never>((_resolve, reject) => { arrivalTimer = setTimeout(() => reject(new Error('Loopback request did not arrive')), 2_000) }),
    ])
    clearTimeout(arrivalTimer)
    controller.abort('private cancellation reason')
    // If signal propagation regresses, end the local request so the negative test
    // fails cleanly instead of leaving an orphan socket. Forced closure is a failure.
    cleanupTimer = setTimeout(() => { forcedClose = true; server.closeAllConnections() }, 1_000)
    const outcome = await result
    expect(outcome).toMatchObject({ code: 'cancelled' }); expect(String(outcome)).not.toContain('private cancellation reason')
    await disconnected
    expect(forcedClose).toBe(false)
  } finally { clearTimeout(arrivalTimer); clearTimeout(cleanupTimer); sdk.destroy(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())) }
}, 10_000)
