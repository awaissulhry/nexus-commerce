import { describe, expect, it } from 'vitest'
import { ABUSE_POLICIES, abuseVerdict, challengeBits, isAbusePolicy, waitWords } from './policies'
import { issueChallenge, meetsDifficulty, POW, solveChallenge, verifyProof } from './pow'

const KEY = Buffer.alloc(32, 3)
const NOW = new Date('2026-11-04T10:00:00.000Z')
const NETWORK = 'network-hash-a'

describe('proof-of-work challenge (PLT-066: self-hosted, no third party)', () => {
  it('checks leading zero bits of SHA-256', () => {
    const challenge = 'pw1.test'
    const nonce = solveChallenge(challenge, 10)!
    expect(nonce).not.toBeNull()
    expect(meetsDifficulty(challenge, nonce, 10)).toBe(true)
    expect(meetsDifficulty(challenge, nonce, 0)).toBe(true)
  })

  it('accepts a solved challenge of this policy and network, once valid', () => {
    const issued = issueChallenge(KEY, { policy: 'portal.signin.start', bits: 8, subject: NETWORK, now: NOW })
    expect(issued.bits).toBe(POW.minBits)
    const nonce = solveChallenge(issued.value, issued.bits)!
    const expected = { policy: 'portal.signin.start', subject: NETWORK, minBits: 8, now: NOW }
    expect(verifyProof(KEY, { challenge: issued.value, nonce }, expected)).toEqual({ ok: true, salt: issued.salt, bits: 8 })
  })

  it('refuses a made-up, changed, carried or stale challenge, or an unsolved one', () => {
    const issued = issueChallenge(KEY, { policy: 'portal.signin.start', bits: 8, subject: NETWORK, now: NOW })
    const nonce = solveChallenge(issued.value, issued.bits)!
    const expected = { policy: 'portal.signin.start', subject: NETWORK, minBits: 8, now: NOW }
    expect(verifyProof(KEY, { challenge: issued.value, nonce }, { ...expected, subject: 'network-hash-b' })).toMatchObject({ ok: false, reason: 'forged' })
    expect(verifyProof(Buffer.alloc(32, 4), { challenge: issued.value, nonce }, expected)).toMatchObject({ ok: false, reason: 'forged' })
    expect(verifyProof(KEY, { challenge: issued.value.replace('.8.', '.9.'), nonce }, expected)).toMatchObject({ ok: false, reason: 'forged' })
    expect(verifyProof(KEY, { challenge: issued.value, nonce }, { ...expected, policy: 'portal.signin.code' })).toMatchObject({ ok: false, reason: 'other_policy' })
    expect(verifyProof(KEY, { challenge: issued.value, nonce }, { ...expected, now: new Date(NOW.getTime() + POW.ttlMs) })).toMatchObject({ ok: false, reason: 'expired' })
    expect(verifyProof(KEY, { challenge: issued.value, nonce }, { ...expected, minBits: 9 })).toMatchObject({ ok: false, reason: 'too_easy' })
    const wrong = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].find((candidate) => !meetsDifficulty(issued.value, candidate, 8))!
    expect(verifyProof(KEY, { challenge: issued.value, nonce: wrong }, expected)).toMatchObject({ ok: false, reason: 'unsolved' })
    expect(verifyProof(KEY, { challenge: 'garbage', nonce }, expected)).toMatchObject({ ok: false, reason: 'malformed' })
    expect(verifyProof(KEY, { challenge: issued.value, nonce: 'not allowed!' }, expected)).toMatchObject({ ok: false, reason: 'malformed' })
  })
})

describe('abuse policies (design portal.signin: 3 per address in 10 minutes; a challenge only after suspicious traffic)', () => {
  const start = ABUSE_POLICIES['portal.signin.start']
  const quiet = { subjectHits: 1, subjectResetInMs: 600_000, networkHits: 1, networkResetInMs: 600_000, networkFailures: 0 }

  it('lets a person ask three times, then holds the fourth with the wait in words', () => {
    expect(abuseVerdict(start, { ...quiet, subjectHits: 3 })).toEqual({ kind: 'allow' })
    expect(abuseVerdict(start, { ...quiet, subjectHits: 4, subjectResetInMs: 3 * 60_000 + 10_000 })).toEqual({ kind: 'wait', retryAfterMs: 190_000, by: 'subject' })
    expect(waitWords(190_000)).toBe('Wait 4 minutes before asking again.')
    expect(waitWords(60_000)).toBe('Wait 1 minute before asking again.')
    expect(waitWords(5_000)).toBe('Wait 5 seconds before asking again.')
  })

  it('asks a challenge from a busy network, harder as it gets busier, and holds it above the hard limit', () => {
    expect(abuseVerdict(start, { ...quiet, networkHits: start.challengeAfter.hits })).toEqual({ kind: 'allow' })
    expect(abuseVerdict(start, { ...quiet, networkHits: start.challengeAfter.hits + 1 })).toEqual({ kind: 'challenge', bits: start.bits })
    expect(challengeBits(start, { networkHits: start.challengeAfter.hits * 4, networkFailures: 0 })).toBe(start.bits + 2)
    expect(abuseVerdict(start, { ...quiet, networkHits: start.perNetwork + 1 })).toMatchObject({ kind: 'wait', by: 'network' })
    const code = ABUSE_POLICIES['portal.signin.code']
    expect(abuseVerdict(code, { ...quiet, networkFailures: code.challengeAfter.failures })).toMatchObject({ kind: 'challenge' })
    expect(challengeBits(code, { networkHits: 1, networkFailures: 1_000_000 })).toBe(POW.maxBits)
  })

  it('names its policies', () => {
    expect(isAbusePolicy('portal.signin.start')).toBe(true)
    expect(isAbusePolicy('links.renew')).toBe(true)
    expect(isAbusePolicy('public.lookup')).toBe(true)
    expect(isAbusePolicy('toString')).toBe(false)
  })
})
