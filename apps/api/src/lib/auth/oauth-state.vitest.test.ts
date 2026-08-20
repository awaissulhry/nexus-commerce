/**
 * MAP.4 — the signed OAuth state.
 *
 * This is security code AND the fix for a live incident: "State token mismatch -
 * possible CSRF attack" on legitimate connects, caused by a browser-side check
 * that could not survive the flow opening eBay in its own window. The tests that
 * matter most here are the REFUSALS — a state check that cannot fail is the
 * `state.length >= 32` check this replaced.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest'
import { signOAuthState, verifyOAuthState } from './oauth-state.js'

beforeAll(() => {
  process.env.NEXUS_CREDENTIAL_ENC_KEY ??= 'test-signing-key-for-oauth-state'
})

describe('signOAuthState / verifyOAuthState — the happy path', () => {
  it('accepts a state it just issued', () => {
    const v = verifyOAuthState(signOAuthState({ channel: 'EBAY' }), 'EBAY')
    expect(v.ok).toBe(true)
    expect(v.payload?.channel).toBe('EBAY')
  })

  it('carries the adopt intent through, tamper-proof', () => {
    const v = verifyOAuthState(signOAuthState({ channel: 'EBAY', adoptConnectionId: 'conn_123' }), 'EBAY')
    expect(v.ok).toBe(true)
    expect(v.payload?.adoptConnectionId).toBe('conn_123')
  })

  it('omits the adopt intent when none was asked for', () => {
    const v = verifyOAuthState(signOAuthState({ channel: 'EBAY' }), 'EBAY')
    expect(v.payload?.adoptConnectionId).toBeUndefined()
  })

  it('issues a different state every time', () => {
    expect(signOAuthState({ channel: 'EBAY' })).not.toBe(signOAuthState({ channel: 'EBAY' }))
  })
})

describe('verifyOAuthState — the refusals', () => {
  it('REFUSES a forged state — the check this replaced accepted any 32 characters', () => {
    expect(verifyOAuthState('a'.repeat(64), 'EBAY').ok).toBe(false)
    expect(verifyOAuthState('a'.repeat(64), 'EBAY').reason).toBe('malformed')
  })

  it('REFUSES a tampered payload — re-pointing the adopt target must not verify', () => {
    const good = signOAuthState({ channel: 'EBAY', adoptConnectionId: 'conn_mine' })
    const sig = good.slice(good.lastIndexOf('.'))
    const evil = Buffer.from(
      JSON.stringify({ channel: 'EBAY', n: 'x', iat: Date.now(), adoptConnectionId: 'conn_theirs' }),
      'utf8',
    ).toString('base64url')
    const v = verifyOAuthState(evil + sig, 'EBAY')
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('bad_signature')
  })

  it('REFUSES a state minted for another channel', () => {
    const v = verifyOAuthState(signOAuthState({ channel: 'SHOPIFY' }), 'EBAY')
    expect(v.ok).toBe(false)
    expect(v.reason).toBe('wrong_channel')
  })

  it('REFUSES a genuinely-signed state once it is too old', () => {
    // Fake timers so the state is REALLY signed by us and only its AGE fails it.
    // Asserting via a forged signature instead would prove nothing about expiry.
    vi.useFakeTimers()
    try {
      const state = signOAuthState({ channel: 'EBAY' })
      expect(verifyOAuthState(state, 'EBAY').ok).toBe(true) // valid now

      vi.advanceTimersByTime(9 * 60 * 1000)
      expect(verifyOAuthState(state, 'EBAY').ok).toBe(true) // still inside the window

      vi.advanceTimersByTime(2 * 60 * 1000) // now 11 minutes old
      const v = verifyOAuthState(state, 'EBAY')
      expect(v.ok).toBe(false)
      expect(v.reason).toBe('expired')
    } finally {
      vi.useRealTimers()
    }
  })

  it('REFUSES empty, undefined and shapeless input', () => {
    expect(verifyOAuthState(undefined, 'EBAY').ok).toBe(false)
    expect(verifyOAuthState('', 'EBAY').ok).toBe(false)
    expect(verifyOAuthState('no-dot-here', 'EBAY').ok).toBe(false)
    expect(verifyOAuthState('.onlyasignature', 'EBAY').ok).toBe(false)
  })

  it('never throws on hostile input — a crash here is a 500 on a public callback', () => {
    for (const bad of ['..', 'x.y', '%%%.%%%', 'a'.repeat(5000) + '.b']) {
      expect(() => verifyOAuthState(bad, 'EBAY')).not.toThrow()
    }
  })
})
