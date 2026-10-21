/**
 * Meta ads step 30 — the two checks before Nexus reads a byte of a Meta webhook delivery: X-Hub-Signature-256 over the
 * RAW bytes (constant time), and the verify token of Meta's GET (constant time, whatever the lengths).
 */
import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { metaChallengeOf, metaVerifyTokenOk, metaWebhookSignatureOk } from './webhook-signature.js'

const SECRET = '0123456789abcdef0123456789abcdef'
const sign = (bytes: Buffer, secret = SECRET) => `sha256=${createHmac('sha256', secret).update(bytes).digest('hex')}`

describe('X-Hub-Signature-256', () => {
  // Meta signs the escaped-unicode bytes it sends; the same JSON parsed and re-serialised is other bytes.
  const raw = Buffer.from('{"object":"page","entry":[{"id":"120000000000001","time":1,"changes":[{"field":"feed","value":{"message":"\\u00e4\\u00f6\\u00e5"}}]}]}')

  it('matches only the HMAC of exactly the bytes received, under the app secret', () => {
    expect(metaWebhookSignatureOk(raw, sign(raw), SECRET)).toBe(true)
    expect(metaWebhookSignatureOk(raw, sign(raw).toUpperCase().replace('SHA256=', 'sha256='), SECRET)).toBe(true)
    const reserialised = Buffer.from(JSON.stringify(JSON.parse(raw.toString('utf8'))))
    expect(reserialised.equals(raw)).toBe(false)
    expect(metaWebhookSignatureOk(reserialised, sign(raw), SECRET)).toBe(false)
  })

  it('refuses another secret, a missing or malformed header, sha1, several headers and an empty secret', () => {
    expect(metaWebhookSignatureOk(raw, sign(raw, 'another-secret-of-another-business'), SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, undefined, SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, '', SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, sign(raw).slice(7), SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, `sha1=${createHmac('sha1', SECRET).update(raw).digest('hex')}`, SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, `${sign(raw)}00`, SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, [sign(raw), sign(raw)], SECRET)).toBe(false)
    expect(metaWebhookSignatureOk(raw, [sign(raw)], SECRET)).toBe(true)
    expect(metaWebhookSignatureOk(raw, sign(raw, ''), '')).toBe(false)
  })
})

describe('the verification GET', () => {
  it('the verify token: equal only to the one Nexus gave Meta; unset or empty never verifies', () => {
    expect(metaVerifyTokenOk('a-long-verify-token-for-tests', 'a-long-verify-token-for-tests')).toBe(true)
    expect(metaVerifyTokenOk('a-long-verify-token-for-tests', ' a-long-verify-token-for-tests ')).toBe(true)
    expect(metaVerifyTokenOk('a-long-verify-token-for-test', 'a-long-verify-token-for-tests')).toBe(false)
    expect(metaVerifyTokenOk('x', 'a-long-verify-token-for-tests')).toBe(false)
    expect(metaVerifyTokenOk('', '')).toBe(false)
    expect(metaVerifyTokenOk('anything', undefined)).toBe(false)
    expect(metaVerifyTokenOk('anything', '   ')).toBe(false)
    expect(metaVerifyTokenOk(['a', 'b'], 'a')).toBe(false)
  })

  it('the challenge: echoed as sent when it is plain visible text; refused otherwise', () => {
    expect(metaChallengeOf('1158201444')).toBe('1158201444')
    expect(metaChallengeOf('CHALLENGE_ACCEPTED')).toBe('CHALLENGE_ACCEPTED')
    expect(metaChallengeOf('')).toBeNull()
    expect(metaChallengeOf('a b')).toBeNull()
    expect(metaChallengeOf('<script>')).toBeNull()
    expect(metaChallengeOf('a/b')).toBeNull()
    expect(metaChallengeOf('9'.repeat(513))).toBeNull()
    expect(metaChallengeOf(['1', '2'])).toBeNull()
  })
})
