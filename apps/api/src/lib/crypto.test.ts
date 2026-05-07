/**
 * CR.1 — crypto helper smoke tests. Pattern matches the repo
 * convention (sendcloud/client.test.ts): pure functions, no DB, no
 * network, run via `npx tsx <file>`. Vitest harness lands with
 * TECH_DEBT #42.
 *
 * What we verify:
 *   • round-trip encrypts decrypt cleanly (string + JSON blob)
 *   • envelope starts with "v1:" + isEncrypted() detects it
 *   • two encrypts of the same plaintext yield different envelopes (random IV)
 *   • tampered ciphertext + tampered auth tag both fail decrypt
 *   • decrypt refuses non-v1 envelopes
 *   • cross-key decrypt fails (no plaintext leak across rotations)
 *   • missing / wrong-length env key throws clearly at first use
 */

import crypto from 'node:crypto'
import {
  encryptSecret,
  decryptSecret,
  isEncrypted,
  __test,
} from './crypto.js'

const tests: Array<{ name: string; fn: () => void | Promise<void> }> = []
function test(name: string, fn: () => void | Promise<void>) {
  tests.push({ name, fn })
}
function assert(cond: unknown, msg = 'assertion failed') {
  if (!cond) throw new Error(msg)
}
function assertThrows(fn: () => unknown, matcher?: RegExp, msg = 'expected throw') {
  try { fn() } catch (e: any) {
    if (matcher && !matcher.test(String(e?.message ?? e))) {
      throw new Error(`${msg}: error message ${e?.message ?? e} doesn't match ${matcher}`)
    }
    return
  }
  throw new Error(msg)
}

const validKey = crypto.randomBytes(32).toString('base64')

function withKey(k: string | undefined, fn: () => void): void {
  const prev = process.env.NEXUS_CREDENTIAL_ENC_KEY
  if (k === undefined) delete process.env.NEXUS_CREDENTIAL_ENC_KEY
  else process.env.NEXUS_CREDENTIAL_ENC_KEY = k
  __test.resetKeyCache()
  try { fn() } finally {
    if (prev === undefined) delete process.env.NEXUS_CREDENTIAL_ENC_KEY
    else process.env.NEXUS_CREDENTIAL_ENC_KEY = prev
    __test.resetKeyCache()
  }
}

test('round-trips a plain string', () => {
  withKey(validKey, () => {
    const env = encryptSecret('hello-world')
    assert(decryptSecret(env) === 'hello-world')
  })
})

test('round-trips a JSON blob (real Sendcloud creds shape)', () => {
  withKey(validKey, () => {
    const payload = JSON.stringify({ publicKey: 'PK_x', privateKey: 'SK_y', integrationId: 12345 })
    const env = encryptSecret(payload)
    assert(decryptSecret(env) === payload)
  })
})

test('envelope starts with v1: and isEncrypted detects it', () => {
  withKey(validKey, () => {
    const env = encryptSecret('x')
    assert(env.startsWith('v1:'))
    assert(isEncrypted(env) === true)
  })
})

test('isEncrypted returns false on legacy plaintext / empty / nullish', () => {
  assert(isEncrypted('{"publicKey":"x"}') === false)
  assert(isEncrypted('') === false)
  assert(isEncrypted(null as any) === false)
  assert(isEncrypted(undefined as any) === false)
})

test('two encrypts of the same plaintext yield different envelopes', () => {
  withKey(validKey, () => {
    const a = encryptSecret('secret')
    const b = encryptSecret('secret')
    assert(a !== b, 'IVs must be random per call')
    assert(decryptSecret(a) === 'secret')
    assert(decryptSecret(b) === 'secret')
  })
})

test('decrypt throws on tampered ciphertext', () => {
  withKey(validKey, () => {
    const env = encryptSecret('secret')
    const parts = env.slice(3).split('.')
    const ctBuf = Buffer.from(parts[2], 'base64url')
    ctBuf[0] ^= 0x01
    parts[2] = ctBuf.toString('base64url')
    const tampered = `v1:${parts.join('.')}`
    assertThrows(() => decryptSecret(tampered))
  })
})

test('decrypt throws on tampered auth tag', () => {
  withKey(validKey, () => {
    const env = encryptSecret('secret')
    const parts = env.slice(3).split('.')
    const tagBuf = Buffer.from(parts[1], 'base64url')
    tagBuf[0] ^= 0x01
    parts[1] = tagBuf.toString('base64url')
    const tampered = `v1:${parts.join('.')}`
    assertThrows(() => decryptSecret(tampered))
  })
})

test('decrypt throws on non-v1 envelope', () => {
  withKey(validKey, () => {
    assertThrows(() => decryptSecret('{"publicKey":"x"}'), /non-v1 envelope/)
  })
})

test('decrypt with wrong key fails (no plaintext leak across rotations)', () => {
  const otherKey = crypto.randomBytes(32).toString('base64')
  let env = ''
  withKey(otherKey, () => { env = encryptSecret('secret') })
  withKey(validKey, () => { assertThrows(() => decryptSecret(env)) })
})

test('encrypt throws when env key is missing', () => {
  withKey(undefined, () => {
    assertThrows(() => encryptSecret('x'), /NEXUS_CREDENTIAL_ENC_KEY is not set/)
  })
})

test('encrypt throws when env key is wrong length', () => {
  const shortKey = crypto.randomBytes(16).toString('base64') // 128-bit, half what we need
  withKey(shortKey, () => {
    assertThrows(() => encryptSecret('x'), /must decode to 32 bytes/)
  })
})

;(async () => {
  let passed = 0
  let failed = 0
  for (const t of tests) {
    try {
      await t.fn()
      passed++
    } catch (err) {
      failed++
      // eslint-disable-next-line no-console
      console.error(`FAIL: ${t.name}`, err instanceof Error ? err.message : err)
    }
  }
  if (failed > 0) {
    // eslint-disable-next-line no-console
    console.error(`crypto.test.ts: ${failed} failed / ${passed} passed`)
    process.exit(1)
  }
  // eslint-disable-next-line no-console
  console.log(`crypto.test.ts: ${passed}/${passed} passed`)
})()
