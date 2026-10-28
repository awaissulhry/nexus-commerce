import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Authenticator } from '../../../core/context'
import { sessionAuthenticator } from './authenticator'
import { DEVICE_COOKIE, FLOOR_COOKIE } from './cookies'
import { floorHash, matchesHash, mintSessionToken, mintSiteToken, parseSessionToken, parseSiteToken } from './tokens'

describe('floor tokens', () => {
  it('a device token names its tenant, site and device; only its hash is stored', () => {
    const [tenantId, siteId, deviceId] = [newId(), newId(), newId()]
    const token = mintSiteToken(tenantId, siteId, deviceId)
    expect(parseSiteToken(token.value)).toEqual({ tenantId, siteId, id: deviceId, value: token.value })
    expect(floorHash(token.value)).toMatch(/^[0-9a-f]{64}$/)
    expect(matchesHash(floorHash(token.value), token.value)).toBe(true)
    expect(matchesHash(floorHash(token.value), mintSiteToken(tenantId, siteId, deviceId).value)).toBe(false)
    expect(matchesHash(null, token.value)).toBe(false)
  })

  it('refuses anything that is not a token', () => {
    const token = mintSiteToken(newId(), newId(), newId()).value
    for (const bad of [undefined, 42, '', 'a.b.c.d', `${token}.x`, token.slice(0, -1), token.replace(/\.[^.]+$/, '.short'), 'x'.repeat(300)]) {
      expect(parseSiteToken(bad)).toBeNull()
    }
    expect(parseSessionToken(mintSessionToken())).not.toBeNull()
    expect(parseSessionToken('not a token')).toBeNull()
    expect(mintSessionToken()).not.toBe(mintSessionToken())
  })
})

describe('the app authenticator', () => {
  const request = (cookies: Record<string, string>) => ({ cookies }) as unknown as FastifyRequest
  const office: Authenticator = () => ({ audience: 'office', tenantId: 't', actorId: 'office', grants: [] })
  const floor: Authenticator = () => null

  it('sends a request with the floor session cookie to the floor authenticator only (no office fallback)', async () => {
    const authenticate = sessionAuthenticator(office, floor)
    expect(await authenticate(request({ [FLOOR_COOKIE]: mintSessionToken(), __Host_factory_session: 'x' }))).toBeNull()
    expect(await authenticate(request({}))).toMatchObject({ audience: 'office' })
    // A device token alone (an enrolled tablet before a sign-in) is not a floor session.
    expect(await authenticate(request({ [DEVICE_COOKIE]: 'x' }))).toMatchObject({ audience: 'office' })
  })
})
