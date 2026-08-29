/**
 * CX.1 — the public projection of a ChannelConnection must never carry a
 * credential. Every caller outside the token service reads rows through
 * CONNECTION_PUBLIC_SELECT, so a secret key here would leak to every route.
 */
import { describe, it, expect, vi } from 'vitest'

vi.mock('../db.js', () => ({ default: {} }))

const { CONNECTION_PUBLIC_SELECT } = await import('./connection-resolver.service.js')

const CREDENTIAL_KEYS = ['accessToken', 'refreshToken', 'ebayAccessToken', 'ebayRefreshToken', 'credentialsEnc'] as const

describe('CONNECTION_PUBLIC_SELECT', () => {
  it('selects none of the five credential columns', () => {
    const keys = Object.keys(CONNECTION_PUBLIC_SELECT)
    for (const secret of CREDENTIAL_KEYS) {
      expect(keys, `${secret} must not be in the public select`).not.toContain(secret)
    }
  })

  it('does not smuggle a credential in under a false value either', () => {
    // A key present with `false` is still a key a refactor could flip to true.
    for (const secret of CREDENTIAL_KEYS) {
      expect(Object.prototype.hasOwnProperty.call(CONNECTION_PUBLIC_SELECT, secret)).toBe(false)
    }
  })

  it('exposes the CX.1 health columns the Channels page renders', () => {
    const select = CONNECTION_PUBLIC_SELECT as Record<string, boolean>
    expect(select.authStatus).toBe(true)
    expect(select.grantedScopes).toBe(true)
    expect(select.refreshTokenExpiresAt).toBe(true)
    expect(select.accessTokenExpiresAt).toBe(true)
    expect(select.lastHeartbeatAt).toBe(true)
    expect(select.consecutiveFailures).toBe(true)
    expect(select.identity).toBe(true)
  })

  it('every selected column is `true` (a plain projection, no nested relations)', () => {
    for (const [k, v] of Object.entries(CONNECTION_PUBLIC_SELECT)) {
      expect(v, `${k} should be a boolean true`).toBe(true)
    }
  })
})
