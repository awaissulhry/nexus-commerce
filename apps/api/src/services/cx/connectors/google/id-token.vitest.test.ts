/**
 * Google sign-in identity from the token answer's id_token: Google's issuer, our client id, not expired.
 */
import { describe, expect, it } from 'vitest'
import { identityFromGoogleIdToken } from './id-token.js'

const CLIENT = '123-abc.apps.googleusercontent.com'
const NOW = Date.UTC(2026, 9, 13, 12)
const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url')
const jwt = (claims: Record<string, unknown>) => `${b64({ alg: 'RS256', kid: 'k' })}.${b64(claims)}.signature`
const good = { iss: 'https://accounts.google.com', aud: CLIENT, sub: '109876543210', email: 'owner@example.test', email_verified: true, exp: NOW / 1000 + 3600, iat: NOW / 1000 }

describe('identityFromGoogleIdToken', () => {
  it('a good token → the Google account id (sub) and the email', () => {
    expect(identityFromGoogleIdToken(jwt(good), { clientId: CLIENT, nowMs: NOW })).toEqual({ userId: '109876543210', username: 'owner@example.test', extra: { hostedDomain: null } })
    expect(identityFromGoogleIdToken(jwt({ ...good, iss: 'accounts.google.com', hd: 'example.test' }), { clientId: CLIENT, nowMs: NOW })).toMatchObject({ userId: '109876543210', extra: { hostedDomain: 'example.test' } })
  })
  it.each([
    ['another audience', { aud: 'someone-else.apps.googleusercontent.com' }],
    ['several audiences, issued to someone else', { aud: [CLIENT, 'other'], azp: 'other' }],
    ['another issuer', { iss: 'https://evil.example.test' }],
    ['expired', { exp: NOW / 1000 - 3600 }],
    ['no expiry', { exp: undefined }],
    ['no subject', { sub: '' }],
  ])('%s → null', (_name, over) => {
    expect(identityFromGoogleIdToken(jwt({ ...good, ...over }), { clientId: CLIENT, nowMs: NOW })).toBeNull()
  })
  it('several audiences issued to us are accepted', () => {
    expect(identityFromGoogleIdToken(jwt({ ...good, aud: [CLIENT, 'other'], azp: CLIENT }), { clientId: CLIENT, nowMs: NOW })?.userId).toBe('109876543210')
  })
  it('an unverified email is not used as the name', () => {
    expect(identityFromGoogleIdToken(jwt({ ...good, email_verified: false }), { clientId: CLIENT, nowMs: NOW })?.username).toBeUndefined()
  })
  it.each([[undefined], [''], ['not-a-jwt'], ['a.b'], [`x.${Buffer.from('not json').toString('base64url')}.y`], [42]])('garbage %j → null', (token) => {
    expect(identityFromGoogleIdToken(token, { clientId: CLIENT, nowMs: NOW })).toBeNull()
  })
  it('no client id configured → null (nothing to check the audience against)', () => {
    expect(identityFromGoogleIdToken(jwt(good), { clientId: '', nowMs: NOW })).toBeNull()
  })
})
