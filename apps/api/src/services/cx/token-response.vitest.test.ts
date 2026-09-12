import { describe, expect, it } from 'vitest'
import { parseTokenResponse, tokenLifetime } from './token-response.js'

describe('untrusted provider token responses', () => {
  it.each([null, [], { access_token: {} }, { access_token: 42 }, { access_token: ' ' }, { access_token: 'a', refresh_token: ' ' }, { access_token: 'a', scope: [] }].map(value => ({ value })))('rejects malformed envelopes: $value', ({ value }) => {
    expect(() => parseTokenResponse(JSON.stringify(value))).toThrow()
  })
  it.each([0, -1, '', ' ', true, {}, Number.MAX_VALUE, Infinity, 'invalid'])('rejects unusable expiry values: %j', value => {
    expect(() => tokenLifetime(value, 3600)).toThrow()
  })
  it('preserves zero granted scopes and valid non-expiring tokens', () => {
    expect(parseTokenResponse('{"access_token":"a","scope":""}').scope).toBe('')
    expect(tokenLifetime(undefined, null)).toBeNull()
    expect(tokenLifetime('3600', null)).toBe(3600)
  })
})
