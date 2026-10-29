import type { FastifyRequest } from 'fastify'
import { describe, expect, it } from 'vitest'
import { newId } from '@nexus/factory-domain/core/ids'
import type { Authenticator } from '../../../core/context'
import { sessionAuthenticator } from './authenticator'
import { DEVICE_COOKIE, FLOOR_COOKIE } from './cookies'
import { FLOOR_STEP_UP_VALID_MS, FloorStepUpRequiredError, floorSteppedUp, floorStepUpUntil } from './step-up'
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

describe('the floor step-up (Owner answer F1 a)', () => {
  const at = new Date('2026-10-29T08:00:00.000Z')
  const later = (ms: number) => new Date(at.getTime() + ms)

  it('a badge alone has no step-up; a proved PIN opens signing acts for two minutes', () => {
    expect(floorStepUpUntil(null)).toBeNull()
    expect(floorSteppedUp(null, at)).toBe(false)
    expect(FLOOR_STEP_UP_VALID_MS).toBe(2 * 60_000)
    expect(floorStepUpUntil(at)).toEqual(later(FLOOR_STEP_UP_VALID_MS))
    expect(floorSteppedUp(at, later(FLOOR_STEP_UP_VALID_MS - 1))).toBe(true)
    expect(floorSteppedUp(at, later(FLOOR_STEP_UP_VALID_MS))).toBe(false)
  })

  it('asks with a 403 that names stepUp, the issue the web reads as "show the PIN pad"', () => {
    const error = new FloorStepUpRequiredError()
    expect(error.code).toBe('forbidden')
    expect(error.issues).toEqual([{ path: 'stepUp', message: 'Required.' }])
  })
})
