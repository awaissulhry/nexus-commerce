/**
 * CX.1 — the public projection of a ChannelConnection must never carry a
 * credential. Every caller outside the token service reads rows through
 * CONNECTION_PUBLIC_SELECT, so a secret key here would leak to every route.
 */
import { describe, it, expect, vi } from 'vitest'

const { findMany } = vi.hoisted(() => ({ findMany: vi.fn() }))
vi.mock('../db.js', () => ({ default: { channelConnection: { findMany } } }))

const { CONNECTION_PUBLIC_SELECT, listManagedConnections, resolveConnectionForProfile, AmbiguousConnectionError, NoConnectionError } = await import('./connection-resolver.service.js')

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

describe('profile and account directory resolution', () => {
  it('requires exactly one profile grant even when one of two matches is primary', async () => {
    findMany.mockResolvedValueOnce([])
    await expect(resolveConnectionForProfile('AMAZON_ADS', 'profile-a', 'EU')).rejects.toBeInstanceOf(NoConnectionError)
    findMany.mockResolvedValueOnce([
      { id: 'one', channelType: 'AMAZON_ADS', isActive: true, isPrimary: true },
      { id: 'two', channelType: 'AMAZON_ADS', isActive: true, isPrimary: false },
    ])
    await expect(resolveConnectionForProfile('AMAZON_ADS', 'profile-a', 'EU')).rejects.toBeInstanceOf(AmbiguousConnectionError)
  })
  it('bounds profile resolution to its channel, region and live grants without selecting credentials', async () => {
    findMany.mockResolvedValueOnce([{ id: 'one', channelType: 'AMAZON_ADS', isActive: true, isPrimary: false }])
    expect((await resolveConnectionForProfile('AMAZON_ADS', 'profile-a', 'EU')).id).toBe('one')
    expect(findMany).toHaveBeenLastCalledWith({
      where: { channelType: 'AMAZON_ADS', isActive: true, authStatus: { notIn: ['disconnected', 'revoked', 'needs_reauth'] }, scopes: { some: { kind: 'profile', externalId: 'profile-a', isActive: true, region: 'EU' } } },
      select: CONNECTION_PUBLIC_SELECT, take: 2,
    })
  })
  it('includes disconnected accounts only when explicitly requested and keeps credentials private', async () => {
    findMany.mockResolvedValue([])
    await listManagedConnections()
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: expect.objectContaining({ isActive: true }), select: CONNECTION_PUBLIC_SELECT }))
    await listManagedConnections(true)
    expect(findMany).toHaveBeenLastCalledWith(expect.objectContaining({ where: { OR: [{ managedBy: 'oauth' }, { managedBy: 'env' }] }, select: CONNECTION_PUBLIC_SELECT }))
  })
})
