/**
 * P2.5 — the Standard Webhooks scheme, which `connectors/etsy/spec.ts` has declared
 * since the connector was written and which nothing implemented. There was no Etsy
 * receiver at all, so there was nothing for a wrong assumption to collide with.
 */
import { describe, it, expect } from 'vitest'
import crypto from 'node:crypto'
import { verifyStandardWebhook, signStandardWebhook, STANDARD_WEBHOOK_TOLERANCE_SECONDS } from './standard-webhooks.js'

const SECRET = `whsec_${Buffer.from('a-signing-key-of-reasonable-size').toString('base64')}`
const ID = 'msg_2abc'
const NOW = new Date('2026-09-20T12:00:00Z')
const TS = Math.floor(NOW.getTime() / 1000)
const BODY = JSON.stringify({ event: 'order.paid', receipt_id: 3344556677 })

// `??` would swallow an explicit `undefined` and quietly restore the default, so a
// test for a MISSING header would silently test a present one. `in` distinguishes
// "not overridden" from "overridden to nothing".
const headers = (over: Record<string, string | undefined> = {}) => ({
  id: 'id' in over ? over.id : ID,
  timestamp: 'timestamp' in over ? over.timestamp : String(TS),
  signature: 'signature' in over ? over.signature : signStandardWebhook(ID, TS, BODY, SECRET),
})

const verify = (over: Record<string, string | undefined> = {}, body: string = BODY, secret: string | null = SECRET) =>
  verifyStandardWebhook({ rawBody: Buffer.from(body, 'utf8'), headers: headers(over), secret, now: NOW })

describe('a genuine delivery', () => {
  it('passes, and reports the sender\'s delivery id', () => {
    const verdict = verify()
    expect(verdict.ok).toBe(true)
    expect(verdict.reason).toBe('ok')
    // This becomes the ledger's dedupe key: stable across the sender's retries, and
    // different for every new change to the same receipt.
    expect(verdict.webhookId).toBe(ID)
  })

  it('accepts a secret with no whsec_ prefix, since the prefix is not part of the key', () => {
    const bare = SECRET.slice('whsec_'.length)
    const sig = signStandardWebhook(ID, TS, BODY, bare)
    expect(verify({ signature: sig }, BODY, bare).ok).toBe(true)
    // And the two forms must agree, or a rotated secret pasted without its prefix
    // would silently reject every delivery.
    expect(verify({ signature: sig }).ok).toBe(true)
  })

  it('passes when the sender presents several signatures during a key rotation', () => {
    const other = `whsec_${Buffer.from('a-different-key-entirely-here!!').toString('base64')}`
    const both = `${signStandardWebhook(ID, TS, BODY, other)} ${signStandardWebhook(ID, TS, BODY, SECRET)}`
    expect(verify({ signature: both }).ok).toBe(true)
    // Order must not matter, or a rotation breaks depending on which key the sender
    // happens to list first.
    const reversed = both.split(' ').reverse().join(' ')
    expect(verify({ signature: reversed }).ok).toBe(true)
  })
})

describe('a delivery that must be refused', () => {
  it('refuses a body that changed by one character', () => {
    const tampered = BODY.replace('3344556677', '3344556678')
    expect(verify({}, tampered).reason).toBe('signature_mismatch')
  })

  it('refuses a signature made with a different key', () => {
    const other = `whsec_${Buffer.from('a-different-key-entirely-here!!').toString('base64')}`
    expect(verify({ signature: signStandardWebhook(ID, TS, BODY, other) }).reason).toBe('signature_mismatch')
  })

  it('refuses when the id it was signed with is not the id it presents', () => {
    // The id is part of the signed content, so swapping it must break the signature —
    // otherwise a captured delivery could be replayed under a fresh id and slip past
    // the ledger's dedupe.
    expect(verify({ id: 'msg_someone_elses' }).reason).toBe('signature_mismatch')
  })

  it('refuses a signature that is too OLD, and one from the future', () => {
    const old = TS - STANDARD_WEBHOOK_TOLERANCE_SECONDS - 1
    expect(verifyStandardWebhook({
      rawBody: Buffer.from(BODY), secret: SECRET, now: NOW,
      headers: { id: ID, timestamp: String(old), signature: signStandardWebhook(ID, old, BODY, SECRET) },
    }).reason).toBe('timestamp_out_of_tolerance')

    // Both directions. A one-sided check leaves a replay window as wide as the
    // sender's clock skew, and a future timestamp is as much a forgery signal.
    const ahead = TS + STANDARD_WEBHOOK_TOLERANCE_SECONDS + 1
    expect(verifyStandardWebhook({
      rawBody: Buffer.from(BODY), secret: SECRET, now: NOW,
      headers: { id: ID, timestamp: String(ahead), signature: signStandardWebhook(ID, ahead, BODY, SECRET) },
    }).reason).toBe('timestamp_out_of_tolerance')
  })

  it('names each missing piece rather than reporting a generic failure', () => {
    expect(verify({ id: undefined }).reason).toBe('missing_headers')
    expect(verify({ signature: undefined }).reason).toBe('missing_headers')
    expect(verify({}, BODY, null).reason).toBe('missing_secret')
    expect(verify({ timestamp: 'not-a-number' }).reason).toBe('bad_timestamp')
    // A reason an operator can act on: `signature_mismatch` sends someone hunting a
    // key, `missing_secret` sends them to the environment, and confusing the two is
    // hours.
    expect(verify({ signature: 'v2,something' }).reason).toBe('no_v1_signature')
  })

  it('refuses an empty signature', () => {
    // What this actually proves is the LENGTH check: the expected value is always a
    // 32-byte digest, so `v1,` fails on length alone. The separate zero-length guard
    // in the comparison is unreachable from here — a mutation deleting it changed
    // nothing — and the code says so rather than implying this test covers it.
    expect(verify({ signature: 'v1,' }).reason).toBe('signature_mismatch')
  })
})

describe('the signature is over the raw bytes', () => {
  it('fails if the body is re-serialised, even to identical-looking JSON', () => {
    // Key order and unicode escaping change under a re-serialise, which is exactly why
    // the receiver captures rawBody. A test that signs `JSON.stringify(parse(body))`
    // would pass and prove nothing.
    const reserialised = JSON.stringify(JSON.parse(BODY), Object.keys(JSON.parse(BODY)).reverse())
    expect(reserialised).not.toBe(BODY)
    expect(verify({}, reserialised).reason).toBe('signature_mismatch')
  })

  it('signs the same bytes a sender would', () => {
    // An independent computation of the expected value: if the implementation and this
    // test both used signStandardWebhook, they would agree while both being wrong.
    const key = Buffer.from(SECRET.slice('whsec_'.length), 'base64')
    const expected = crypto.createHmac('sha256', key).update(`${ID}.${TS}.${BODY}`).digest('base64')
    expect(signStandardWebhook(ID, TS, BODY, SECRET)).toBe(`v1,${expected}`)
  })
})
